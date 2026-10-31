@echo off
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /out:"..\host.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll Program.cs
if errorlevel 1 (
  echo BUILD FAILED
) else (
  echo BUILD OK
)
timeout /t 8 >nul
