$b = [System.IO.File]::ReadAllBytes('c:\Users\tclre\Documents\HAILEY\Athria-repo\apps\desktop\src\overview.tsx')
$crlf = 0
$lf = 0
for ($i = 0; $i -lt $b.Length; $i++) {
  if ($b[$i] -eq 10) {
    if ($i -gt 0 -and $b[$i-1] -eq 13) { $crlf++ } else { $lf++ }
  }
}
Write-Output ("CRLF=" + $crlf + " LF=" + $lf)
