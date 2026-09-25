@echo off
cd /d "%~dp0"

REM --- 1. Vérifier si Python est installé ---
python --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Python est déjà installé.
    goto LANCER_SERVEUR
)

REM --- 2. Vérifier si winget est disponible ---
winget --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Erreur : winget n'est pas disponible sur ce système.
    echo Veuillez installer Python manuellement depuis python.org
    pause
    exit /b 1
)

REM --- 3. Installer Python silencieusement via winget ---
echo Python n'est pas détecté. Installation en cours...
winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
    echo Erreur lors de l'installation de Python.
    pause
    exit /b 1
)

REM --- 4. Rafraîchir le PATH pour la session en cours ---
REM Note : Cette étape est complexe en batch pur. 
REM Le plus simple est de demander à l'utilisateur de relancer le script.
echo.
echo Installation terminée. Veuillez FERMER cette fenêtre et relancer le script.
pause
exit /b 0

:LANCER_SERVEUR
REM --- 5. Lancer le serveur et Firefox ---
echo Démarrage du serveur...
start "" python -m http.server
timeout /t 2 /nobreak >nul
start "" firefox http://localhost:8000/diagnostic.html
pause