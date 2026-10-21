# GitHub 배포 준비

## 저장소 소개

**저장소 이름 제안:** `talkcloud-cleaner`

**짧은 설명:** 톡클라우드에서 날짜·유형·크기로 항목을 찾고, 필요한 파일은 보관하며 선택한 항목을 휴지통으로 정리하는 비공식 Edge 확장.

**Topics 제안:** `edge-extension`, `browser-extension`, `kakao`, `talkcloud`, `javascript`

첫 화면에는 [README](../README.md)를 사용하고, Release 본문에는 [배포 설명](RELEASE_NOTES.md)을 사용합니다. 사용자 식별자, 개인 설치 경로와 실제 사용 화면을 소개에 넣지 않습니다.

## 공개 파일 준비

프로젝트 루트에서 실행합니다. Node.js 24에서 검증한 명령이며 별도 패키지 설치가 필요하지 않습니다.

```sh
node --test extension/tests/*.test.cjs tools/tests/*.test.cjs
node tools/check-public.cjs
node tools/build-public.cjs
```

빌드는 명시적으로 허용한 파일만 다음 결과에 담습니다.

| 결과 | 용도 |
| --- | --- |
| `releases/talkcloud-cleaner-v0.7.2.zip` | 사용자 설치용. 압축을 풀면 루트에 `manifest.json`이 있음 |
| `releases/talkcloud-cleaner-source-v0.7.2.zip` | 공개 저장소 업로드용 소스·테스트·문서 |
| `releases/public-manifest-v0.7.2.json` | 공개 패키지 파일 목록과 해시 |

전체 작업 폴더나 기존 ZIP을 그대로 업로드하지 마세요. `PROJECT.md`, `reference/`, 과거 배포본, 개인 설정 백업과 작업 기록은 공개 목록에 포함하지 않습니다. 새 버전에 파일을 추가하면 검사기와 `.gitignore`의 허용 목록도 함께 검토합니다. 파일명을 허용 목록에 넣는 것만으로 그 내용이 안전해지는 것은 아닙니다.

## 저장소 업로드

공개용 소스 ZIP을 새 폴더에 풀어 업로드하면 내부 작업 자료를 함께 선택할 위험을 줄일 수 있습니다. 저장소에 README나 라이선스를 미리 만들었다면 같은 이름의 파일을 합칠 때 내용을 확인하세요.

Git을 사용하는 경우 첫 커밋 전에 공개할 작성자 이름과 GitHub 설정에 표시되는 본인의 `noreply` 이메일을 저장소별로 설정하세요. 아래 값은 직접 채울 자리입니다.

```sh
git config user.name "PUBLIC_DISPLAY_NAME"
git config user.email "YOUR_GITHUB_NOREPLY_ADDRESS"
git status --short
git diff --cached --stat
git diff --cached
```

커밋 작성자 이메일은 코드 파일과 별도로 기록됩니다. 이메일 설정을 바꿔도 이전 커밋의 이메일은 바뀌지 않습니다. [GitHub의 커밋 이메일 설정 안내](https://docs.github.com/en/account-and-profile/how-tos/email-preferences/setting-your-commit-email-address)를 확인하세요.

`.gitignore`는 새 파일의 실수 포함을 줄이는 장치이며, 이미 추적 중인 파일이나 과거 커밋을 지우지 않습니다. 공개 파일 검사도 알려진 패턴을 찾는 도구이므로 실제 파일 내용과 스테이징 목록 검토를 함께 수행해야 합니다.

## Release 만들기

- 태그: `v0.7.2`
- 제목: `톡클라우드 정리 0.7.2`
- 본문: [RELEASE_NOTES.md](RELEASE_NOTES.md)
- 첨부: 새 설치용 ZIP과 공개 파일 해시 목록. 필요하면 공개 소스 ZIP도 첨부

GitHub 공개와 Edge 확장 스토어 등록은 별개입니다. 이 배포는 압축을 풀어 로컬에 설치하는 형태입니다. [Microsoft의 로컬 확장 설치 안내](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)에서 개발자 모드와 설치 절차를 확인할 수 있습니다.

## 라이선스

공개 전에 적용할 라이선스와 표기할 저작권자 이름을 정하세요. 실명·개인 이메일 대신 공개용 이름을 사용할지 함께 확인합니다. 선택한 라이선스 원문은 루트의 `LICENSE`에 둡니다. 아직 선택하지 않았다면 임의로 MIT 또는 다른 라이선스를 적용하거나 해당 배지를 표시하지 않습니다. [GitHub 라이선스 추가 안내](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository)를 참고하세요.
