$ErrorActionPreference='Stop'
$base = $args[0]      # extracted xlsx dir
$outFile = $args[1]   # output json path

$NSU = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"

# ---- shared strings ----
$ss = New-Object System.Xml.XmlDocument
$ss.Load("$base\xl\sharedStrings.xml")
$strings = New-Object System.Collections.ArrayList
foreach ($si in $ss.DocumentElement.ChildNodes) { [void]$strings.Add($si.InnerText) }

# ---- styles -> fill rgb ----
$st = New-Object System.Xml.XmlDocument
$st.Load("$base\xl\styles.xml")
$sns = New-Object System.Xml.XmlNamespaceManager($st.NameTable); $sns.AddNamespace("d",$NSU)
$fills = $st.SelectNodes("//d:fills/d:fill",$sns)
$xfs   = $st.SelectNodes("//d:cellXfs/d:xf",$sns)
$styleFill = @{}
for ($i=0; $i -lt $xfs.Count; $i++) {
  $flid = [int]$xfs[$i].GetAttribute("fillId")
  $rgb = ""
  if ($flid -lt $fills.Count) {
    $pf = $fills[$flid].SelectSingleNode("d:patternFill",$sns)
    if ($pf) { $fg = $pf.SelectSingleNode("d:fgColor",$sns); if ($fg) { $rgb = $fg.GetAttribute("rgb") } }
  }
  $styleFill[$i] = $rgb
}
function Get-Tag([string]$sid) {
  if ($sid -eq "" -or $null -eq $sid) { return "" }
  $rgb = $styleFill[[int]$sid]
  switch ($rgb) {
    "FFFF0000" { return "holiday" }
    "FFFFFF00" { return "important" }
    "FF92D050" { return "goal" }
    default    { return "" }
  }
}

# ---- sheet1 ----
$doc = New-Object System.Xml.XmlDocument
$doc.Load("$base\xl\worksheets\sheet1.xml")
$ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable); $ns.AddNamespace("d",$NSU)
$rowNodes = $doc.SelectNodes("//d:sheetData/d:row",$ns)

# index rows by row number
$rowByNum = @{}
foreach ($r in $rowNodes) { $rowByNum[[int]$r.GetAttribute("r")] = $r }

function Get-Cells($rowNode) {
  $h = @{}
  if ($null -eq $rowNode) { return $h }
  foreach ($c in $rowNode.ChildNodes) {
    $ref = $c.GetAttribute("r")
    $col = ($ref -replace '[0-9]','')
    $t = $c.GetAttribute("t"); $s = $c.GetAttribute("s")
    $v = $c.SelectSingleNode("d:v",$ns); $isn = $c.SelectSingleNode("d:is",$ns)
    $val = ""
    if ($t -eq "s" -and $v) { $val = $strings[[int]$v.InnerText] }
    elseif ($isn) { $val = $isn.InnerText }
    elseif ($v)  { $val = $v.InnerText }
    if ($val -ne "") { $h[$col] = @{ v = $val; s = $s } }
  }
  return $h
}

$epoch = Get-Date -Year 1899 -Month 12 -Day 30 -Hour 0 -Minute 0 -Second 0
$days  = @{}   # yyyy-MM-dd -> @{text;tag}
$weeks = @{}   # yyyy-MM-dd (block first date) -> weekly goal text
$tmplRe = '^\s*1\s*2?\s*3?\s*4?\s*5?\s*6?\s*$'

$rowNums = $rowByNum.Keys | Sort-Object
foreach ($rn in $rowNums) {
  $cells = Get-Cells $rowByNum[$rn]
  # is this a date row? >=3 numeric cells in serial range
  $colDate = @{}
  foreach ($k in $cells.Keys) {
    $val = $cells[$k].v
    if ($val -match '^\d{4,6}$') {
      $n = [int]$val
      if ($n -ge 43000 -and $n -le 47000) { $colDate[$k] = $epoch.AddDays($n).ToString('yyyy-MM-dd') }
    }
  }
  if ($colDate.Count -lt 3) { continue }

  $contentRow = Get-Cells $rowByNum[($rn + 2)]
  if ($contentRow.Count -eq 0) { continue }

  $firstDate = ($colDate.Values | Sort-Object)[0]

  foreach ($k in $contentRow.Keys) {
    $txt = ($contentRow[$k].v -replace "`r`n","`n").Trim()
    if ($txt -eq "") { continue }
    if ($txt -match $tmplRe) { continue }
    $tag = Get-Tag $contentRow[$k].s

    if ($colDate.ContainsKey($k)) {
      $d = $colDate[$k]
      if ($days.ContainsKey($d)) { $days[$d].text = $days[$d].text + "`n" + $txt }
      else { $days[$d] = @{ text = $txt; tag = $tag } }
    } else {
      # non-date column in the content row: weekly goal / 비고
      if ($weeks.ContainsKey($firstDate)) { $weeks[$firstDate] = $weeks[$firstDate] + "`n" + $txt }
      else { $weeks[$firstDate] = $txt }
    }
  }
}

$obj = [ordered]@{
  version   = 1
  source    = "xlsx-sheet1"
  exportedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
  days      = [ordered]@{}
  weeks     = [ordered]@{}
}
foreach ($d in ($days.Keys | Sort-Object)) { $obj.days[$d] = $days[$d] }
foreach ($w in ($weeks.Keys | Sort-Object)) { $obj.weeks[$w] = $weeks[$w] }

$json = $obj | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($outFile, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("days={0} weeks={1}" -f $days.Count, $weeks.Count)
Write-Output ("range: {0} ~ {1}" -f ($days.Keys|Sort-Object)[0], ($days.Keys|Sort-Object)[-1])
