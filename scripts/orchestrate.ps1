param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $RemainingArgs
)

if ($RemainingArgs.Count -eq 0) {
  & direxio deploy
} else {
  & direxio @RemainingArgs
}
exit $LASTEXITCODE
