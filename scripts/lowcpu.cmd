@echo off
REM Executa qualquer comando preso a 1 nucleo (afinidade) e com prioridade baixa.
REM Processos filhos (rustc, node, link.exe) herdam afinidade e prioridade.
REM Uso: scripts\lowcpu.cmd cargo build
start /B /WAIT /AFFINITY 1 /LOW %*
