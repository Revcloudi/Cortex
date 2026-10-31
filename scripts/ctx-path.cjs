#!/usr/bin/env node
/**
 * `ctx` PATH helper used by the Windows installer only.
 *
 * The NSIS installer asks (unchecked by default) whether to put
 * `<install>\bin` on the **current user's** PATH. NSIS string surgery is
 * error-prone, so the installer delegates the registry edit to the bundled
 * Node runtime + PowerShell:
 *
 *   node.exe ctx-path.cjs add "C:\...\bin"
 *   node.exe ctx-path.cjs remove "C:\...\bin"
 *
 * Only `HKCU\Environment\Path` is touched — never the system PATH, never a
 * shell profile. Any failure exits non-zero so the installer can warn and
 * continue. The file is also shipped in the macOS runtime tree for layout
 * parity, but PATH edits there are not supported (no-op with an error).
 */
'use strict'

const { spawnSync } = require('node:child_process')

const action = process.argv[2]
const directory = process.argv[3]
if ((action !== 'add' && action !== 'remove') || typeof directory !== 'string' || directory.length === 0) {
  console.error('用法: node ctx-path.cjs <add|remove> <bin目录>')
  process.exit(2)
}

if (process.platform !== 'win32') {
  console.error('[ctx-path] 仅支持 Windows 当前用户 PATH；macOS 请自行配置 shell profile')
  process.exit(1)
}

function psLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`
}

function runPowerShell(script) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  )
  if (result.error) {
    console.error(`PowerShell 启动失败: ${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    console.error(`PATH 更新失败: ${(result.stderr || '').trim()}`)
    return false
  }
  return true
}

const target = psLiteral(directory)
const script =
  action === 'add'
    ? `$dir = ${target}; $p = [Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $p) { $p = '' }; $parts = @($p -split ';' | Where-Object { $_ -and $_.Length -gt 0 }); if ($parts -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User') }`
    : `$dir = ${target}; $p = [Environment]::GetEnvironmentVariable('Path','User'); if ($null -ne $p) { $parts = @($p -split ';' | Where-Object { $_ -and $_ -ne $dir }); [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User') }`

if (!runPowerShell(script)) process.exit(1)
console.log(`[ctx-path] ${action === 'add' ? '已加入' : '已移除'} 用户 PATH: ${directory}`)
