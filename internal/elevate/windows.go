package elevate

import (
	"encoding/base64"
	"strings"
	"unicode/utf16"
)

// RunAsScript is the PowerShell the powershell tool runs for an elevated command on Windows. A
// process started with -Verb RunAs (which shows the UAC prompt) cannot write to its caller's pipes,
// so the elevated powershell runs command in cwd with every output stream written to outPath, and
// this script prints that file, removes it, and exits with the elevated process's exit code.
// Declining the UAC prompt makes Start-Process fail with ERROR_CANCELLED (1223); the script then
// writes DeclinedMarker to stderr.
//
// The inner script travels Base64-encoded (-EncodedCommand), so no quoting reaches the command; the
// paths are single-quoted PowerShell literals.
func RunAsScript(command, cwd, outPath string) string {
	var inner strings.Builder
	inner.WriteString("$ErrorActionPreference = 'Continue'\n")
	inner.WriteString("$out = " + psQuote(outPath) + "\n")
	inner.WriteString("$code = 0\n")
	inner.WriteString("try {\n")
	if strings.TrimSpace(cwd) != "" {
		inner.WriteString("  Set-Location -LiteralPath " + psQuote(cwd) + "\n")
	}
	inner.WriteString("  $Error.Clear()\n")
	inner.WriteString("  $global:LASTEXITCODE = $null\n")
	inner.WriteString("  & {\n" + command + "\n} *>&1 | Out-File -LiteralPath $out -Encoding utf8 -Width 4096\n")
	inner.WriteString("  if ($LASTEXITCODE -is [int]) { $code = $LASTEXITCODE } elseif ($Error.Count -gt 0) { $code = 1 }\n")
	inner.WriteString("} catch {\n")
	inner.WriteString("  $_ | Out-File -LiteralPath $out -Encoding utf8 -Append -Width 4096\n")
	inner.WriteString("  $code = 1\n")
	inner.WriteString("}\n")
	inner.WriteString("exit $code\n")

	var outer strings.Builder
	outer.WriteString("$out = " + psQuote(outPath) + "\n")
	outer.WriteString("try {\n")
	outer.WriteString("  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '" + EncodeCommand(inner.String()) + "')\n")
	outer.WriteString("} catch {\n")
	outer.WriteString("  $e = $_.Exception\n")
	outer.WriteString("  $native = if ($e.InnerException) { $e.InnerException.NativeErrorCode } else { $e.NativeErrorCode }\n")
	outer.WriteString("  if ($native -eq 1223 -or $e.Message -match 'cancel') {\n")
	outer.WriteString("    [Console]::Error.WriteLine(" + psQuote(DeclinedMarker) + ")\n")
	outer.WriteString("  } else {\n")
	outer.WriteString("    [Console]::Error.WriteLine('mistermorph: could not start the elevated command: ' + $e.Message)\n")
	outer.WriteString("  }\n")
	outer.WriteString("  exit 1\n")
	outer.WriteString("}\n")
	outer.WriteString("if (Test-Path -LiteralPath $out) {\n")
	outer.WriteString("  Get-Content -LiteralPath $out -Raw -Encoding UTF8\n")
	outer.WriteString("  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue\n")
	outer.WriteString("}\n")
	outer.WriteString("exit $p.ExitCode\n")
	return outer.String()
}

// EncodeCommand is a script in the form powershell's -EncodedCommand takes: UTF-16LE, Base64.
func EncodeCommand(script string) string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		raw = append(raw, byte(unit), byte(unit>>8))
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// psQuote is s as a single-quoted PowerShell string literal.
func psQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
