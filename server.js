// MMW Content Engine — Server
// Zero external dependencies. Requires Node.js 14+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

// Inline .env loader
(function() {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(function(line) {
      line = line.trim();
      if (!line || line[0] === '#') return;
      var i = line.indexOf('=');
      if (i < 1) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    });
  } catch(e) {}
})();

var PORT = process.env.PORT || 3000;
var API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('\n  ANTHROPIC_API_KEY not found.');
  console.error('  Create a .env file with: ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function callAnthropic(payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      }
    };
    var req = https.request(options, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseMultipart(body, boundary) {
  var parts = [];
  var boundaryBuf = Buffer.from('--' + boundary);
  var pos = 0;
  while (pos < body.length) {
    var bIdx = body.indexOf(boundaryBuf, pos);
    if (bIdx === -1) break;
    var hStart = bIdx + boundaryBuf.length + 2;
    var hEnd = body.indexOf(Buffer.from('\r\n\r\n'), hStart);
    if (hEnd === -1) break;
    var headers = body.slice(hStart, hEnd).toString('utf8');
    var dStart = hEnd + 4;
    var next = body.indexOf(boundaryBuf, dStart);
    var dEnd = next === -1 ? body.length : next - 2;
    var nm = headers.match(/name="([^"]+)"/);
    var fn = headers.match(/filename="([^"]+)"/);
    var ct = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (nm) parts.push({
      name: nm[1],
      filename: fn ? fn[1] : null,
      contentType: ct ? ct[1].trim() : 'text/plain',
      data: body.slice(dStart, dEnd)
    });
    pos = next === -1 ? body.length : next;
  }
  return parts;
}

function extractDocxText(buffer) {
  var sig = Buffer.from('PK\x03\x04');
  var pos = 0;
  while (pos < buffer.length - 30) {
    if (buffer.slice(pos, pos+4).equals(sig)) {
      var fnLen = buffer.readUInt16LE(pos + 26);
      var exLen = buffer.readUInt16LE(pos + 28);
      var fnStart = pos + 30;
      var filename = buffer.slice(fnStart, fnStart + fnLen).toString('utf8');
      var dStart = fnStart + fnLen + exLen;
      var compSize = buffer.readUInt32LE(pos + 18);
      var method = buffer.readUInt16LE(pos + 8);
      if (filename === 'word/document.xml') {
        var xml;
        if (method === 0) {
          xml = buffer.slice(dStart, dStart + compSize).toString('utf8');
        } else if (method === 8) {
          xml = zlib.inflateRawSync(buffer.slice(dStart, dStart + compSize)).toString('utf8');
        } else {
          throw new Error('Unsupported compression method: ' + method);
        }
        return xml
          .replace(/<w:p[ >][^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#[0-9]+;/g, '')
          .replace(/\n{3,}/g, '\n\n').trim();
      }
      pos = dStart + compSize;
    } else { pos++; }
  }
  throw new Error('word/document.xml not found in file');
}

var server = http.createServer(function(req, res) {
  var url = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve HTML
  if (req.method === 'GET' && url === '/') {
    try {
      var html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) { res.writeHead(500); res.end('index.html not found'); }
    return;
  }

  // Parse documents
  if (req.method === 'POST' && url === '/api/parse') {
    readBody(req).then(function(rawBody) {
      var ct = req.headers['content-type'] || '';
      var boundary = ct.split('boundary=')[1];
      if (!boundary) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' })); return;
      }
      var parts = parseMultipart(rawBody, boundary);
      var contentParts = [];

      parts.forEach(function(part) {
        if (!part.filename) return;
        var label = part.name === 'onboarding' ? 'ONBOARDING FORM' : 'MASTER RECORD';
        var fn = part.filename.toLowerCase();
        if (fn.endsWith('.pdf')) {
          contentParts.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: part.data.toString('base64') },
            title: label
          });
        } else if (fn.endsWith('.docx') || fn.endsWith('.doc')) {
          try {
            var text = extractDocxText(part.data);
            contentParts.push({ type: 'text', text: '--- ' + label + ' ---\n' + text + '\n' });
          } catch(e) {
            contentParts.push({ type: 'text', text: '--- ' + label + ' --- [DOCX extract failed: ' + e.message + ']\n' });
          }
        } else if (fn.endsWith('.txt')) {
          contentParts.push({ type: 'text', text: '--- ' + label + ' ---\n' + part.data.toString('utf8') + '\n' });
        }
      });

      if (contentParts.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No readable content found in uploaded files.' })); return;
      }

      contentParts.push({ type: 'text', text: 'Extract all client information. Return ONLY a JSON object:\n{"practiceName":"","website":"","primaryLocation":"","additionalLocations":[],"virtualCare":false,"virtualStates":[],"phone":"","email":"","providerName":"","providerCredentials":"","additionalProviders":[],"targetDemographic":"","brandVoice":"","toneDescriptors":[],"wordsToAvoid":[],"service1":"","service2":"","service3":"","allServices":[],"devices":[],"targetCities":[],"targetCounties":[],"paymentOptions":"","insuranceAccepted":"","uniquePositioning":"","socialMedia":{},"yearFounded":"","brandColors":"","existingWebsite":"","gaps":[]}\n\nUse null for unknown values. Use "GAP: [description]" for clearly needed but missing fields. Return ONLY the JSON, no markdown.' });

      return callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{ role: 'user', content: contentParts }]
      });
    }).then(function(result) {
      if (!result) return;
      if (result.status !== 200) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.body.error && result.body.error.message || 'API error' })); return;
      }
      var raw = result.body.content[0].text.trim()
        .replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    }).catch(function(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Proxy all other Claude calls
  if (req.method === 'POST' && url === '/api/claude') {
    readBody(req).then(function(rawBody) {
      return callAnthropic(JSON.parse(rawBody.toString()));
    }).then(function(result) {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    }).catch(function(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, function() {
  console.log('\n  MMW Content Engine running');
  console.log('  Open: http://localhost:' + PORT + '\n');
});
