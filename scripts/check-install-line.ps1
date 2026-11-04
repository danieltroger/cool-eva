$ErrorActionPreference = 'Stop'
$workspace = Join-Path (Get-Location) '.preview-shots/install-line-windows'
New-Item -ItemType Directory -Force $workspace | Out-Null
$fixture = Join-Path $workspace 'ssh.exe'
if (Test-Path $fixture) { Remove-Item -LiteralPath $fixture }
$source = @'
using System;
using System.IO;
using System.Text;
public class CaptureSshArguments {
  public static void Main(string[] arguments) {
    using (var output = new StreamWriter(Environment.GetEnvironmentVariable("COOL_EVA_ARGV_FILE"))) {
      foreach (var argument in arguments) {
        output.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(argument)));
      }
    }
  }
}
'@
Add-Type -TypeDefinition $source -OutputAssembly $fixture -OutputType ConsoleApplication
$env:PATH = "$workspace;$env:PATH"
$env:COOL_EVA_ARGV_FILE = Join-Path $workspace 'arguments.txt'
$line = & node --experimental-strip-types --input-type=module --eval "import {installerOneLine} from './scripts/release/installer.ts'; console.log(installerOneLine());"
if ($LASTEXITCODE -ne 0) { throw 'Cannot render the installer one-liner' }
$remote = & node --experimental-strip-types --input-type=module --eval "import {installerRemoteCommand} from './scripts/release/installer.ts'; console.log(installerRemoteCommand());"
Invoke-Expression $line
$arguments = @(Get-Content -LiteralPath $env:COOL_EVA_ARGV_FILE | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
if ($arguments.Count -ne 3 -or $arguments[0] -ne '-tt' -or $arguments[1] -ne 'pi@cool-eva.local' -or $arguments[2] -cne $remote) {
  throw 'Windows PowerShell changed the SSH argument boundary'
}
$commandFile = Join-Path $workspace 'paste.ps1'
Set-Content -LiteralPath $commandFile -Value $line
& pwsh -NoProfile -File $commandFile
if ($LASTEXITCODE -ne 0) { throw 'PowerShell 7 could not execute the one-liner' }
$arguments = @(Get-Content -LiteralPath $env:COOL_EVA_ARGV_FILE | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
if ($arguments.Count -ne 3 -or $arguments[0] -ne '-tt' -or $arguments[1] -ne 'pi@cool-eva.local' -or $arguments[2] -cne $remote) {
  throw 'PowerShell 7 changed the SSH argument boundary'
}
Write-Output 'The same pasted line preserves SSH arguments in Windows PowerShell 5.1 and PowerShell 7.'
