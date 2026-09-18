# Native-Host Authenticode Hash Runner Compatibility — 2026-09-18

Status: root cause confirmed; compatibility fix validated on hosted pull-request CI. Temporary diagnostic hooks are not part of the intended final diff.

## Failure evidence

After readiness PR #33 merged as `9212ce0`, main-push workflow run `35330008066` passed build, version-info, and exact artifact tests but failed at `Record unsigned signing candidate`.

A diagnostic PR then moved the production candidate recorder and signature inspector into ordinary PR CI. Run `35332688245` failed the production paths on GitHub's `windows-2025-vs2026` image `20260907.229.1`.

A second attempt, run `35334848032`, successfully started the Application Identity service before tests but still failed signature inspection for both an unsigned WAG PE and signed `notepad.exe`. Therefore starting `AppIDSvc` is not sufficient for this hosted-runner failure.

## Scope of the failure

The original inspector used `Get-AppLockerFileInformation` only to obtain the SHA-256 PE/catalog hash. Signature state and certificate facts are independently read with `Get-AuthenticodeSignature`.

The main workflow's build step succeeds in the repository workspace. A separate test-only source-signature-removal failure occurred when building under the hosted runner's user `%TEMP%`; moving those test builds to repository-local temporary directories reproduces the production workspace shape without changing production build behavior.
## Upstream Windows API evidence

Microsoft documents `CryptCATAdminAcquireContext2` as the catalog-administration API for selecting a specific hash algorithm:

https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadminacquirecontext2

Microsoft documents `CryptCATAdminCalcHashFromFileHandle2` as calculating a file hash using that selected algorithm. It is supported on Windows Server 2012 and later:

https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadmincalchashfromfilehandle2

The associated catalog context is released with `CryptCATAdminReleaseContext`:

https://learn.microsoft.com/en-us/windows/win32/api/mscat/nf-mscat-cryptcatadminreleasecontext

Microsoft's AppLocker documentation identifies Application Identity as an AppLocker system service, but the hosted-runner attempt above proves that explicitly starting it does not make the current AppLocker cmdlet path reliable in this image:

https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/configure-the-application-identity-service
## Local equivalence probe

A read-only Windows probe compared the existing AppLocker SHA-256 value with `CryptCATAdminAcquireContext2("SHA256") + CryptCATAdminCalcHashFromFileHandle2`.

Results:

```text
signed C:\Windows\System32\notepad.exe
AppLocker = 27264aac7bad8e35f1d48e99221f4d0f0322433a399f9f2d5eb523e1971479ec
CryptCAT  = 27264aac7bad8e35f1d48e99221f4d0f0322433a399f9f2d5eb523e1971479ec
match     = true

unsigned WAG native host
AppLocker = fccc88d515d5044d2beff8a34ee2224e825f8d78b6f96ceff5b8711e8056754c
CryptCAT  = fccc88d515d5044d2beff8a34ee2224e825f8d78b6f96ceff5b8711e8056754c
match     = true
```

A separate `ImageGetDigestStream` probe did not match AppLocker/catalog hashes across tested digest levels, so that approach was rejected.

## Windows PowerShell module-resolution root cause

The Wintrust replacement removed the AppLocker dependency but hosted production-path tests still failed when Node spawned `powershell.exe`. A bounded diagnostic established:

- direct Windows PowerShell invocation from the workflow could resolve `Get-AuthenticodeSignature`;
- the same Windows PowerShell executable spawned through Node ran in `FullLanguage` mode and retained the Windows system module path, but module autoload failed with `CommandNotFoundException`;
- importing `Microsoft.PowerShell.Security` by module name then failed with `FormatXmlUpdateException`.

This matches Microsoft's documented `PSModulePath` behavior when Windows PowerShell is started through an intermediate process beneath PowerShell 7: the intermediate process can inherit PowerShell 7 module paths, and those paths can break Windows PowerShell module autoloading.

Official reference:

https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6

The production inspector therefore imports the Windows PowerShell Security module by its manifest under the child process's own `$PSHOME`, bypassing inherited `PSModulePath` search order:

```powershell
$securityModulePath = "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"
Import-Module $securityModulePath -ErrorAction Stop
```

Hosted PR run `35337456797` on head `cd28940` then passed the Node-spawned PowerShell probe, the focused production-path tests, publish-candidate build, version-info verification, and exact artifact tests.

## Decision

Replace only the inspector's AppLocker hash dependency with the Windows Wintrust catalog hash APIs above, explicitly requesting `SHA256`.

Keep all existing trust checks unchanged:
- exact canonical executable path and no reparse point;
- unsigned candidates must be `NotSigned`;
- signed candidates must report `Valid`;
- signer certificate must be present;
- RSA public key is required;
- Code Signing EKU `1.3.6.1.5.5.7.3.3` is required;
- signer/timestamp identity remains bounded;
- candidate continuity continues to compare the recorded Authenticode/catalog hash.

No signer/provider authority, credential, OIDC, release, or signing behavior is added.

## CI regression gate

Ordinary pull-request validation must continue to run:
- `test/native-host-candidate-cli.test.ts`;
- `test/native-host-signature.test.ts`.

This ensures hosted-runner compatibility for the production recorder and signature inspector is checked before a change reaches `main`.
