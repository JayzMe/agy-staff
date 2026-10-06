// Opt-in real OpenCode V2 package/skill/command test. Every provider points
// at a local fake OpenAI-compatible endpoint, so no model is ever called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.mjs';
import { exec, pack } from './pi-pack-helpers.mjs';

const names = ['agy-ask', 'agy-implementer', 'agy-jobs', 'agy-lead', 'agy-researcher', 'agy-reviewer', 'agy-staffer'];

// Answers "OK" to every chat completion and records what the model was sent.
async function fakeModel(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      requests.push(request);
      const base = { id: 'fake', created: 0, model: request.model };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage }));
        return;
      }
      const chunk = (delta, finish, extra = {}) => `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop', { usage }) + 'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

async function until(what, probe, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

test('OpenCode V2: native package install registers seven skills and commands that attach them', { timeout: 300_000 }, async t => {
  const binary = process.env.AGY_OPENCODE2_BIN || 'opencode';
  const sb = sandbox('opencode2-host');
  t.after(() => fs.rmSync(sb.root, { recursive: true, force: true }));
  const password = randomBytes(16).toString('hex');
  const env = {
    ...process.env, HOME: sb.home, USERPROFILE: sb.home, OPENCODE_TEST_HOME: sb.home,
    XDG_CONFIG_HOME: path.join(sb.root, 'config'), XDG_CACHE_HOME: path.join(sb.root, 'cache'),
    XDG_DATA_HOME: path.join(sb.root, 'data'), XDG_STATE_HOME: path.join(sb.root, 'state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  // Do not inherit host config, auth, server credentials, or inline overrides.
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_CONFIG|OPENCODE_CLI_CONFIG|OPENCODE_AUTH|OPENCODE_SERVER_|OPENCODE_PASSWORD|OPENCODE_API_KEY|OPENCODE_EXPERIMENTAL|OPENCODE_CLIENT|OPENCODE_DB|AGY_.*TOKEN)/.test(key)) delete env[key];
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
  }
  env.OPENCODE_SERVER_PASSWORD = password;
  const version = exec(binary, ['--version'], { cwd: sb.repo, env }).trim().replace(/^opencode\s+v?/, '');
  assert.match(version, /^2\./, 'Set AGY_OPENCODE2_BIN to an OpenCode V2 binary.');
  t.diagnostic(`OpenCode ${version}`);
  const unrelated = path.join(sb.repo, '.opencode/skills/reviewer');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'SKILL.md'), '---\nname: reviewer\ndescription: An unrelated review workflow.\n---\nNot agy.\n');

  // V2 installs npm registry and Git specs only; use a Git fixture of the packed files.
  const { dir: fixture } = pack(sb.root);
  exec('git', ['init', '-q'], { cwd: fixture, env });
  exec('git', ['add', '.'], { cwd: fixture, env });
  exec('git', ['-c', 'user.name=AGY Test', '-c', 'user.email=agy-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Packed fixture'], { cwd: fixture, env });
  const revision = exec('git', ['rev-parse', 'HEAD'], { cwd: fixture, env }).trim();
  const gitSpec = `agy-staff@git+${pathToFileURL(fixture).href}#${revision}`;
  exec(binary, ['plugin', 'add', gitSpec], { cwd: sb.repo, env, timeout: 120_000 });
  const configFile = path.join(env.XDG_CONFIG_HOME, 'opencode/opencode.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(config.plugins, [gitSpec]);
  const model = await fakeModel(t);
  config.model = 'fake/fake-model';
  config.providers = {
    opencode: { settings: { baseURL: model.url } },
    fake: { name: 'Fake', package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: model.url, apiKey: 'fake' }, models: { 'fake-model': { name: 'Fake' } } },
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const server = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: sb.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  t.after(async () => {
    if (server.exitCode !== null) return;
    await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode server startup timed out: ${logs}`)), 60_000);
    const collect = chunk => {
      logs += chunk.toString();
      const match = /https?:\/\/127\.0\.0\.1:\d+/.exec(logs);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`OpenCode server exited ${code}: ${logs}`)); });
  });
  const api = async (route, body) => {
    const response = await fetch(`${url}${route}?directory=${encodeURIComponent(sb.repo)}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    assert.ok(response.ok, `${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };

  // Plugins load in the background after the location boots.
  const skills = await until('agy skills', async () => {
    const found = (await api('/api/skill')).data.filter(skill => skill.id.startsWith('agy-'));
    return found.length === names.length && found;
  });
  const all = (await api('/api/skill')).data;
  assert.ok(all.some(skill => skill.id === 'reviewer'), 'unrelated reviewer skill survives');
  assert.deepEqual(skills.map(skill => skill.id).sort(), names);
  for (const skill of skills) {
    assert.equal(skill.name, skill.id);
    assert.ok(skill.description, skill.id);
    assert.ok(skill.path.endsWith(path.join('opencode-skills', skill.id, 'SKILL.md')), skill.path);
    assert.ok(fs.existsSync(path.resolve(path.dirname(skill.path), '../../companion/agy-companion.mjs')), skill.path);
  }
  const commands = (await api('/api/command')).data;
  assert.deepEqual(commands.filter(command => command.name.startsWith('agy-')).map(command => command.name).sort(), names);

  // A plugin command resubmits the prompt with its skill attached; the host
  // expands the attachment into the skill content and base directory.
  const session = (await api('/api/session', {})).data;
  await api(`/api/session/${session.id}/command`, { name: 'agy-ask', text: 'reply with OK' });
  const text = message => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  const turn = await until('the agy-ask model turn', () => model.requests
    .flatMap(request => request.messages ?? []).filter(message => message.role === 'user').map(text)
    .find(content => content.includes('<skill_content name="agy-ask">')), 60_000);
  const askDir = path.dirname(skills.find(skill => skill.id === 'agy-ask').path);
  assert.ok(turn.includes(`Base directory for this skill: ${askDir}\n`), turn);
  assert.match(turn, /reply with OK$/);
});
