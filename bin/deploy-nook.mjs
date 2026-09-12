#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, statfsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const script = fileURLToPath(import.meta.url);
const defaults = {
  source: resolve(dirname(script), '..'),
  releases: '/fs0/ompweb-release-archive',
  stateDir: join(homedir(), '.local/share/ompweb-deploy'),
  override: join(homedir(), '.config/systemd/user/ompweb.service.d/goals-release.conf'),
  service: 'ompweb.service',
  healthUrl: 'http://10.10.20.139:30177/api/sessions',
  publicUrl: 'https://omp-amos.vxn.rs/',
  candidatePort: 30209,
  rollbackSeconds: 600,
  minimumRootBytes: 2 * 1024 ** 3,
};

export function configuration(overrides = {}) { return { ...defaults, ...overrides }; }
function execute(binary, args, options = {}) {
  return (execFileSync(binary, args, { encoding: 'utf8', timeout: 180000, ...options }) ?? '').trim();
}
function statePath(config) { return join(config.stateDir, 'deployment.json'); }
function atomic(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, path);
}
function save(config, state) { atomic(statePath(config), JSON.stringify(state, null, 2)); }
function load(config) { return JSON.parse(readFileSync(statePath(config), 'utf8')); }
const system = (run, ...args) => run('systemctl', ['--user', ...args]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function healthy(url, statuses = [200]) {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'manual' }); await response.body?.cancel(); return statuses.includes(response.status); }
  catch { return false; }
}

export function releaseOverride(original, previous, release) {
  if (!original.includes(`WorkingDirectory=${previous}`) || !original.includes(`${previous}/bin/omp-web.js`)) {
    throw new Error('Override does not match active release; refusing an ambiguous cutover');
  }
  return original.split(previous).join(release);
}

export async function rollback(config, expectedId, dependencies = {}) {
  const run = dependencies.run ?? execute;
  const state = load(config);
  if (expectedId && state.id !== expectedId) throw new Error('Stale rollback request; deployment identity changed');
  if (state.stage === 'confirmed' || state.stage === 'rolled-back') return state;
  if (!state.armed) throw new Error('This deployment has not armed rollback');
  // The timer may fire after a partially completed override write. Both versions
  // are recoverable, but never overwrite an unrelated later manual deployment.
  const override = readFileSync(config.override, 'utf8');
  if (override !== state.nextOverride && override !== state.previousOverride) throw new Error('Service override changed independently; manual recovery required');
  atomic(config.override, state.previousOverride);
  system(run, 'daemon-reload');
  system(run, 'restart', config.service);
  state.stage = 'rolled-back'; state.finishedAt = new Date().toISOString(); save(config, state);
  return state;
}

export async function confirm(config, expectedId, dependencies = {}) {
  const run = dependencies.run ?? execute;
  const check = dependencies.healthy ?? healthy;
  const state = load(config);
  if (expectedId && state.id !== expectedId) throw new Error('Stale confirmation; deployment identity changed');
  if (state.stage === 'confirmed') return state;
  if (state.stage !== 'awaiting-confirmation') throw new Error(`Cannot confirm deployment in ${state.stage}`);
  if (readFileSync(config.override, 'utf8') !== state.nextOverride) throw new Error('Service override differs from candidate');
  if (system(run, 'show', config.service, '-p', 'WorkingDirectory', '--value') !== state.release || !await check(config.healthUrl)) throw new Error('Candidate is not healthy in production');
  system(run, 'stop', state.timerUnit + '.timer');
  // Guard a timer already dispatched concurrently with confirmation.
  const after = load(config);
  if (after.stage !== 'awaiting-confirmation' || readFileSync(config.override, 'utf8') !== state.nextOverride) throw new Error('Rollback began during confirmation; inspect status');
  state.stage = 'confirmed'; state.finishedAt = new Date().toISOString(); save(config, state);
  return state;
}

export async function deployWorker(config, id, dependencies = {}) {
  const run = dependencies.run ?? execute;
  const check = dependencies.healthy ?? healthy;
  const pause = dependencies.sleep ?? sleep;
  const state = load(config);
  if (state.id !== id || state.stage !== 'queued') throw new Error('Invalid or stale deployment worker');
  const stage = value => { state.stage = value; state.updatedAt = new Date().toISOString(); save(config, state); console.log(value); };
  let candidateStarted = false;
  try {
    const root = statfsSync('/');
    if (root.bavail * root.bsize < config.minimumRootBytes) throw new Error('Insufficient root headroom; no build started');
    mkdirSync(config.releases, { recursive: true });
    if (realpathSync(config.releases).startsWith('/home/')) throw new Error('Release builds must not live on the home/root volume');
    if (existsSync(state.release)) throw new Error('Release directory already exists');
    mkdirSync(state.release);
    stage('copying');
    run('rsync', ['-a', '--exclude=.git', '--exclude=.next', '--exclude=node_modules', '--exclude=tsconfig.tsbuildinfo', config.source + '/', state.release + '/']);
    run('rsync', ['-a', join(config.source, 'node_modules') + '/', join(state.release, 'node_modules') + '/']);
    stage('building');
    run('npm', ['run', 'build'], { cwd: state.release, stdio: 'inherit', timeout: 600000 });
    stage('candidate-check');
    run('systemd-run', ['--user', '--collect', '--unit=' + state.candidateUnit,
      '--property=WorkingDirectory=' + state.release,
      '--property=EnvironmentFile=' + state.environmentFile,
      '--setenv=NODE_ENV=production', '--setenv=OMP_WEB_PACKAGE_DIR=' + state.release,
      '--setenv=OMP_WEB_ACTIVE_SESSIONS_PATH=' + join(state.release, '.candidate-active.json'),
      '--setenv=OMP_WEB_SESSION_PREFERENCES=' + join(state.release, '.candidate-prefs.json'),
      '--setenv=OMP_WEB_REMOTE_SESSIONS_PATH=' + join(state.release, '.candidate-remote.json'),
      process.execPath, join(state.release, 'bin/omp-web.js'), '-H', '127.0.0.1', '-p', String(config.candidatePort), '--no-open']);
    candidateStarted = true;
    let ready = false;
    for (let i = 0; i < 30; i++) { if (await check(`http://127.0.0.1:${config.candidatePort}/api/sessions`)) { ready = true; break; } await pause(1000); }
    if (!ready) throw new Error('Candidate failed readiness');
    if (!await check(`http://127.0.0.1:${config.candidatePort}/manifest.webmanifest`)) throw new Error('Candidate manifest failed');
    system(run, 'stop', state.candidateUnit + '.service'); candidateStarted = false;
    // Recheck immediately before arming so a concurrent manual cutover is not lost.
    if (readFileSync(config.override, 'utf8') !== state.previousOverride) throw new Error('Production override changed during build');
    state.armed = true;
    state.rollbackAt = new Date(Date.now() + config.rollbackSeconds * 1000).toISOString();
    stage('arming-rollback');
    run('systemd-run', ['--user', '--unit=' + state.timerUnit, '--on-active=' + config.rollbackSeconds + 's', '--timer-property=AccuracySec=1s', process.execPath, state.workerScript, 'rollback', '--id', id, '--config', state.configPath]);
    system(run, 'is-active', state.timerUnit + '.timer');
    // No chat/browser dependency from this point; both worker and timer are user services.
    stage('switching');
    atomic(config.override, state.nextOverride);
    system(run, 'daemon-reload');
    system(run, 'restart', config.service);
    let productionReady = false;
    for (let i = 0; i < 30; i++) { if (await check(config.healthUrl)) { productionReady = true; break; } await pause(1000); }
    if (!productionReady) throw new Error('Production health check failed');
    if (system(run, 'show', config.service, '-p', 'WorkingDirectory', '--value') !== state.release) throw new Error('Unexpected active release after restart');
    if (config.publicUrl && !await check(config.publicUrl, [200, 302, 303, 307, 308])) throw new Error('Public endpoint health check failed');
    stage('awaiting-confirmation');
    console.log(`Live; rollback at ${state.rollbackAt}. After browser confirmation: node ${state.workerScript} confirm --id ${id} --config ${state.configPath}`);
    return state;
  } catch (error) {
    if (candidateStarted) { try { system(run, 'stop', state.candidateUnit + '.service'); } catch {} }
    state.error = error instanceof Error ? error.message : String(error);
    save(config, state);
    if (state.armed) { try { await rollback(config, id, dependencies); } catch (recoveryError) { console.error('Rollback failed:', recoveryError); } }
    else stage('failed');
    throw error;
  }
}

export function queueDeployment(config, dependencies = {}) {
  const run = dependencies.run ?? execute;
  if (existsSync(statePath(config))) {
    const prior = load(config);
    if (!['confirmed','rolled-back','failed'].includes(prior.stage)) throw new Error(`Deployment ${prior.id} is ${prior.stage}; resolve it first`);
  }
  const previous = system(run, 'show', config.service, '-p', 'WorkingDirectory', '--value');
  if (!previous || system(run, 'is-active', config.service) !== 'active') throw new Error('Production must be active before deployment');
  const original = readFileSync(config.override, 'utf8');
  const id = new Date().toISOString().replace(/[-:.]/g, '').replace('T','-').replace('Z','') + '-' + randomUUID().slice(0,6);
  const release = join(config.releases, id);
  const runDir = join(config.stateDir, id); mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const workerScript = join(runDir, 'deploy-nook.mjs');
  writeFileSync(workerScript, readFileSync(script), { mode: 0o600 });
  const configPath = join(runDir, 'config.json'); atomic(configPath, JSON.stringify(config));
  // Private environment file avoids putting provider credentials on argv or in logs.
  const environmentFile = join(runDir, 'environment');
  const environment = Object.entries(process.env).filter(([name]) => /^(OMP_|PI_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|PATH$|HOME$)/.test(name));
  atomic(environmentFile, environment.map(([name,value]) => `${name}="${String(value).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('\n','\\n')}"`).join('\n'));
  const state = { id, stage: 'queued', release, previous, previousOverride: original,
    nextOverride: releaseOverride(original, previous, release), workerScript, configPath, environmentFile,
    candidateUnit: 'nook-candidate-' + id, timerUnit: 'nook-rollback-' + id, workerUnit: 'nook-deploy-' + id, armed: false };
  save(config, state);
  try {
    run('systemd-run', ['--user', '--collect', '--unit=' + state.workerUnit, '--property=EnvironmentFile=' + environmentFile, process.execPath, workerScript, 'worker', '--id', id, '--config', configPath]);
  } catch (error) { state.stage = 'failed'; state.error = String(error); save(config, state); throw error; }
  return state;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';
  const option = name => { const index = args.indexOf('--' + name); return index >= 0 ? args[index + 1] : undefined; };
  const configFile = option('config');
  const config = configuration(configFile ? JSON.parse(readFileSync(configFile, 'utf8')) : {});
  if (command === 'deploy') { const state = queueDeployment(config); console.log(`Deployment ${state.id} queued.\nStatus: npm run deploy:status\nLogs: journalctl --user -fu ${state.workerUnit}`); }
  else if (command === 'worker') await deployWorker(config, option('id'));
  else if (command === 'confirm') { const state = await confirm(config, option('id')); console.log(`Confirmed ${state.id}; rollback cancelled.`); }
  else if (command === 'rollback') { const state = await rollback(config, option('id')); console.log(`Rolled back ${state.id}.`); }
  else if (command === 'status') { const state = load(config); console.log(JSON.stringify({id:state.id,stage:state.stage,release:state.release,previous:state.previous,rollbackAt:state.rollbackAt,error:state.error},null,2)); }
  else console.log('Usage: node bin/deploy-nook.mjs deploy|status|confirm|rollback [--id deployment-id] [--config path]\nDeploy runs under systemd independently of Nook. Builds on /fs0, preserves live .next, checks candidate, arms rollback, then switches. Confirm only after reconnecting in the browser.');
}
if (process.argv[1] && resolve(process.argv[1]) === script) main().catch(error => { console.error(error.message); process.exitCode = 1; });
