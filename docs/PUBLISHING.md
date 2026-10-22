# GitHub 배포 안내

## 저장소 소개

**저장소 이름 제안:** `talkcloud-cleaner`

**짧은 설명:** 카카오톡 톡클라우드에서 날짜·유형·크기로 항목을 찾고, 필요한 파일은 보관하며 선택한 항목을 휴지통으로 정리하는 비공식 Edge 확장.

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
| `releases/talkcloud-cleaner-v1.0.0.zip` | 사용자 설치용. 압축을 풀면 루트에 `manifest.json`이 있음 |
| `releases/talkcloud-cleaner-source-v1.0.0.zip` | 공개 저장소 업로드용 소스·테스트·문서 |
| `releases/public-manifest-v1.0.0.json` | 공개 패키지 파일 목록과 해시 |

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

- 태그: `v1.0.0`
- 제목: `카카오톡 톡클라우드 정리 1.0.0`
- 본문: [RELEASE_NOTES.md](RELEASE_NOTES.md)
- 첨부: 새 설치용 ZIP과 공개 파일 해시 목록. 필요하면 공개 소스 ZIP도 첨부
- 일반 릴리스로 게시하고 **This is a pre-release**는 선택하지 않음

태그·문서·`manifest.json`·첨부 파일의 버전을 맞춥니다. 같은 버전을 재배포하면 기존 첨부 파일과 해시 목록을 별도 보관한 뒤 새 패키지로 교체합니다. 버전 번호가 같으므로 사용자는 최신 ZIP을 설치 폴더에 반영하고 확장을 다시 로드해야 합니다.

## 실제 계정 확인 항목

자동 테스트와 공개 파일·ZIP 해시 검증을 완료한 뒤 실제 계정의 소량 항목으로 아래 동작을 확인하고 결과를 기록합니다. 이 문서는 검증 완료를 의미하지 않습니다.

- 날짜·유형·파일 크기 조건과 개별 항목·채팅방·중요 표시 보호
- 저장하지 않는 휴지통 이동, 선택 파일 다운로드와 실제 파일 열기
- 사진·GIF·동영상의 목록 썸네일과 확대·닫기, 파일명 없는 항목 표시, 썸네일 없음·불러오기 실패 안내
- 동영상 대표 이미지와 배지, 페이지·계정 변경 후 썸네일 정리, 작업 기록·JSON에서 URL 제외
- 작업 중지·로그인 만료·연결 끊김 후 결과 구분과 남은 항목 재조회
- 관리 탭 재열기 후 계정·선택 정보·다운로드 기록 재검증, 자동 삭제 재개가 없는지 확인
- 같은 설치 경로의 이전 버전 업데이트와 보호 설정 유지, 다른 설치본으로 보호 설정 이전

실제 계정 통합 검증은 아직 완료되지 않았습니다. 자동 검사와 실제 계정 확인 결과를 구분하여 기록합니다.

GitHub 공개와 Edge 확장 스토어 등록은 별개입니다. 이 배포는 압축을 풀어 로컬에 설치하는 형태입니다. [Microsoft의 로컬 확장 설치 안내](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading)에서 개발자 모드와 설치 절차를 확인할 수 있습니다.

## 라이선스

이 프로젝트는 [MIT 라이선스](../LICENSE)를 적용하며 저작권자 표기는 공개 계정명 `git-jiwon`입니다. 빌드는 루트의 `LICENSE` 원문을 설치용 ZIP과 소스 ZIP에 모두 포함합니다. 배포 시 라이선스 원문과 저작권 고지를 보존하세요.
