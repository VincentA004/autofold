import {afterEach, expect, test} from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {containmentCommand, runInspection} from './inspection-boundary'

const roots: string[] = []
afterEach(async () => {for (const root of roots.splice(0)) await fs.rm(root, {recursive: true, force: true})})
const python = path.resolve(process.env.AUTOFOLD_TEST_PROTO_PYTHON ?? path.resolve(import.meta.dir, '../../../../.autofold/envs/proto/bin/python'))
const provisioned = await fs.access(python).then(() => true, () => false)
const nativeTest = test.skipIf(process.platform !== 'darwin' || !provisioned)

async function contained(source: string, scratch: string) {
  const executable = await fs.realpath(python)
  const argv = await containmentCommand([python, '-c', source], scratch, [path.resolve(path.dirname(python), '..'), path.resolve(path.dirname(executable), '..')])
  const child = Bun.spawn(argv, {cwd: scratch, env: {PATH: path.dirname(python) + ':/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1', TMPDIR: scratch}, stdout: 'pipe', stderr: 'pipe'})
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return {code, stdout, stderr}
}

// This native platform check is separate from portable adapter/component tests.
// It must launch a real interpreter: a denied executable is not proof that an
// otherwise usable inspection boundary enforces the intended restrictions.
// Provisioning is an explicit mandatory prerequisite in the behavioral release
// runner. Portable component suites may omit this platform-specific interpreter.
nativeTest('native containment starts the provisioned framework Python before inspecting authored code', async () => {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-native-bootstrap-')))
  roots.push(scratch)
  expect(await contained('print(123)', scratch)).toEqual({code: 0, stdout: '123\n', stderr: ''})
})

nativeTest('a running native Python can use scratch but cannot read secrets, write outside, connect, or execute a shell', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-native-security-')))
  roots.push(root)
  const scratch = path.join(root, 'scratch'), secret = path.join(root, 'secret'), outside = path.join(root, 'outside')
  await fs.mkdir(scratch)
  await fs.writeFile(secret, 'host-private-fixture')
  await fs.writeFile(outside, 'original')
  let received = 0
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => {received++; return new Response('unexpected')}})
  const source = `import json,os,pathlib,socket
def denied(action):
    try:
        action()
        return False
    except PermissionError:
        return True
pathlib.Path('allowed').write_text('scratch works')
def connect():
    with socket.socket() as sock:
        sock.connect(('127.0.0.1',${server.port}))
print(json.dumps({'scratch':pathlib.Path('allowed').read_text(),
    'secretDenied':denied(lambda:pathlib.Path(${JSON.stringify(secret)}).read_text()),
    'outsideWriteDenied':denied(lambda:pathlib.Path(${JSON.stringify(outside)}).write_text('forbidden')),
    'networkDenied':denied(connect),
    'shellDenied':denied(lambda:os.posix_spawn('/bin/sh',['/bin/sh','-c','exit 0'],{}))}))`
  try {
    const result = await contained(source, scratch)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({scratch: 'scratch works', secretDenied: true, outsideWriteDenied: true, networkDenied: true, shellDenied: true})
    expect(received).toBe(0)
    expect(await fs.readFile(secret, 'utf8')).toBe('host-private-fixture')
    expect(await fs.readFile(outside, 'utf8')).toBe('original')
  } finally {server.stop(true)}
})

nativeTest('native inspection imports the selected packages while neighboring source secrets remain unreadable', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'autofold-native-imports-')))
  roots.push(root)
  const protoRoot = path.join(root, 'pinned'), workerRoot = path.join(root, 'worker')
  const language = path.join(protoRoot, 'proto_language'), tools = path.join(protoRoot, 'proto-tools/proto_tools')
  const secret = path.join(protoRoot, 'neighbor-secret')
  for (const directory of [language, tools, path.join(workerRoot, 'autofold_worker')]) await fs.mkdir(directory, {recursive: true})
  for (const directory of [language, tools, path.join(workerRoot, 'autofold_worker')]) await fs.writeFile(path.join(directory, '__init__.py'), '')
  await fs.writeFile(secret, 'host-private-neighbor')
  await fs.writeFile(path.join(workerRoot, 'autofold_worker/inspection.py'), `import json,pathlib,tempfile,proto_language,proto_tools
with tempfile.TemporaryDirectory() as directory:
    scratch = pathlib.Path(directory)/'allowed'
    scratch.write_text('scratch works')
    scratchWorks = scratch.read_text() == 'scratch works'
try:
    pathlib.Path(${JSON.stringify(secret)}).read_text()
    secretDenied = False
except PermissionError:
    secretDenied = True
print(json.dumps({'language':str(pathlib.Path(proto_language.__file__).resolve().parent),'tools':str(pathlib.Path(proto_tools.__file__).resolve().parent),'secretDenied':secretDenied,'scratchWorks':scratchWorks}))`)
  const result = await runInspection(python, 'discover', [], undefined, {workerRoot, protoRoot})
  expect({code: result.code, stderr: result.stderr}).toEqual({code: 0, stderr: ''})
  expect(JSON.parse(result.stdout)).toEqual({language, tools, secretDenied: true, scratchWorks: true})
  expect(await fs.readFile(secret, 'utf8')).toBe('host-private-neighbor')
})
