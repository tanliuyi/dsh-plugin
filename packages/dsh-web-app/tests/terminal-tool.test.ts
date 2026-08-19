import test from 'node:test'
import assert from 'node:assert/strict'

import { isTerminalTool, terminalToolDataOf } from '../web/src/lib/terminal-tool.ts'

test('recognizes bash-like tool names without changing generic tools', () => {
  assert.equal(isTerminalTool('bash'), true)
  assert.equal(isTerminalTool('pwsh'), true)
  assert.equal(isTerminalTool('BASH'), true)
  assert.equal(isTerminalTool('read'), false)
  assert.equal(terminalToolDataOf('read', '{"path":"a.ts"}', 'file'), null)
})

test('adapts a JSON-encoded command and structured stdout/stderr output', () => {
  assert.deepEqual(
    terminalToolDataOf(
      'bash',
      JSON.stringify(JSON.stringify({ command: 'printf hello' })),
      { stdout: 'hello\n', stderr: 'warning\n', exitCode: 0 },
      'complete',
    ),
    {
      command: 'printf hello',
      lines: ['hello', 'warning'],
      visibleCount: 2,
      done: true,
      success: true,
      exitCode: 0,
    },
  )
})

test('extracts exit markers from the rendered bash/pwsh result text', () => {
  assert.deepEqual(
    terminalToolDataOf(
      'bash',
      JSON.stringify({ command: 'false' }),
      'failed output\n[exit code: 2]\n',
      'complete',
    ),
    {
      command: 'false',
      lines: ['failed output'],
      visibleCount: 1,
      done: true,
      success: false,
      exitCode: 2,
    },
  )

  assert.deepEqual(
    terminalToolDataOf(
      'bash',
      JSON.stringify({ command: 'true' }),
      { stdout: '', stderr: '', exitCode: 0 },
      'complete',
    ),
    {
      command: 'true',
      lines: [],
      visibleCount: 0,
      done: true,
      success: true,
      exitCode: 0,
    },
  )
})

test('keeps running calls live and reads assistant text content blocks', () => {
  assert.deepEqual(
    terminalToolDataOf(
      'pwsh',
      JSON.stringify({ command: 'Get-ChildItem' }),
      undefined,
      'running',
    ),
    {
      command: 'Get-ChildItem',
      lines: [],
      visibleCount: 0,
      done: false,
      success: true,
    },
  )

  assert.deepEqual(
    terminalToolDataOf(
      'bash',
      JSON.stringify({ command: 'false' }),
      [{ type: 'text', text: 'permission denied' }],
      'complete',
      true,
    ),
    {
      command: 'false',
      lines: ['permission denied'],
      visibleCount: 1,
      done: true,
      success: false,
    },
  )
})

test('uses a plain string argument as the command when no object envelope exists', () => {
  assert.deepEqual(
    terminalToolDataOf('sh', 'echo ready', 'ready\n', 'complete'),
    {
      command: 'echo ready',
      lines: ['ready'],
      visibleCount: 1,
      done: true,
      success: true,
    },
  )
})
