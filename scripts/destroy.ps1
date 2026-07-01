param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RemainingArgs
)

& direxio destroy @RemainingArgs
exit $LASTEXITCODE
