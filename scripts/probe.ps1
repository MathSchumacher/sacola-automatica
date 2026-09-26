$p = Get-Process -Id $PID
"affinity=$($p.ProcessorAffinity) priority=$($p.PriorityClass)"
