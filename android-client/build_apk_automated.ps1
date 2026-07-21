$ErrorActionPreference = "Stop"

# We will store all downloaded tools in a local ".tools" folder so we don't mess up your PC
$ToolsDir = "$PSScriptRoot\.tools"
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

Write-Host "1. Downloading portable Java (JDK 17)..." -ForegroundColor Cyan
$JdkZip = "$ToolsDir\jdk17.zip"
if (-not (Test-Path $JdkZip)) {
    Invoke-WebRequest -Uri "https://download.java.net/java/GA/jdk17.0.2/dfd4a8d0985749f896bed50d7138ee7f/8/GPL/openjdk-17.0.2_windows-x64_bin.zip" -OutFile $JdkZip
}
if (-not (Test-Path "$ToolsDir\jdk-17.0.2")) {
    Expand-Archive -Path $JdkZip -DestinationPath $ToolsDir -Force
}
$env:JAVA_HOME = "$ToolsDir\jdk-17.0.2"

Write-Host "2. Downloading Android SDK Command-line Tools..." -ForegroundColor Cyan
$SdkZip = "$ToolsDir\sdk-tools.zip"
if (-not (Test-Path $SdkZip)) {
    Invoke-WebRequest -Uri "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" -OutFile $SdkZip
}
$SdkDir = "$ToolsDir\android-sdk"
if (-not (Test-Path "$SdkDir\cmdline-tools\latest\bin\sdkmanager.bat")) {
    New-Item -ItemType Directory -Force -Path "$SdkDir\cmdline-tools" | Out-Null
    Expand-Archive -Path $SdkZip -DestinationPath "$ToolsDir\temp_sdk" -Force
    Rename-Item -Path "$ToolsDir\temp_sdk\cmdline-tools" -NewName "latest"
    Move-Item -Path "$ToolsDir\temp_sdk\latest" -Destination "$SdkDir\cmdline-tools"
    Remove-Item -Recurse -Force "$ToolsDir\temp_sdk"
}
$env:ANDROID_HOME = $SdkDir

Write-Host "3. Accepting Android SDK Licenses and downloading Android 34..." -ForegroundColor Cyan
$SdkManager = "$SdkDir\cmdline-tools\latest\bin\sdkmanager.bat"
cmd.exe /c "echo y| ""$SdkManager"" --licenses > NUL"
cmd.exe /c """$SdkManager"" ""platforms;android-34"" ""build-tools;34.0.0"""

Write-Host "4. Downloading Gradle 8.2..." -ForegroundColor Cyan
$GradleZip = "$ToolsDir\gradle.zip"
if (-not (Test-Path $GradleZip)) {
    Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-8.2-bin.zip" -OutFile $GradleZip
}
if (-not (Test-Path "$ToolsDir\gradle-8.2")) {
    Expand-Archive -Path $GradleZip -DestinationPath $ToolsDir -Force
}
$GradleBin = "$ToolsDir\gradle-8.2\bin\gradle.bat"

Write-Host "5. Compiling the Android APK..." -ForegroundColor Cyan
Set-Location -Path $PSScriptRoot
& $GradleBin assembleDebug

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n========================================================" -ForegroundColor Green
    Write-Host " SUCCESS! " -ForegroundColor Green
    Write-Host " Your APK is ready to send to your friend:" -ForegroundColor Green
    Write-Host " PATH: $PSScriptRoot\app\build\outputs\apk\debug\app-debug.apk" -ForegroundColor Green
    Write-Host "========================================================" -ForegroundColor Green
} else {
    Write-Host "`nBUILD FAILED." -ForegroundColor Red
}
