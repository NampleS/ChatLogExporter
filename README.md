# ChatLogExporter

NampleS가 만든 BetterDiscord 플러그인. 서버/DM 대화 로그를 캐시해 AI 친화적 아카이브(JSONL·Markdown·ZIP)로 내보내고, 선택한 메시지 범위를 **실제 화면 그대로 긴 스크린샷 이미지**로 복사·저장한다.

## 친구에게 공유 (원클릭 설치)

아래 링크를 눌러 받은 `Install-ChatLogExporter.cmd` 를 더블클릭하면 끝.

**설치 파일:** https://github.com/NampleS/ChatLogExporter/releases/latest/download/Install-ChatLogExporter.cmd

- BetterDiscord 가 먼저 깔려 있어야 한다(https://betterdiscord.app).
- 설치 후 디스코드 → 설정 → 플러그인에서 **ChatLogExporter** 를 켜면 된다.
- 새 버전이 나오면 **알아서 자동 업데이트**된다(아래 참고).

> 설치 파일이 하는 일은 단 하나: 최신 `ChatLogExporter.plugin.js` 를
> `%APPDATA%\BetterDiscord\plugins\` 에 내려받는 것뿐이다.

## 자동 업데이트 (서명 기반)

- 플러그인은 켜진 뒤 잠깐 있다가, 그리고 6시간마다 이 저장소의 `version.json` 을 확인한다.
- 더 높은 버전이 올라와 있으면 `ChatLogExporter.plugin.js` 를 내려받아,
  **제작자의 ed25519 개인키로 서명된 파일인지 검증한 뒤에만** 자기 자신을 덮어쓴다.
- 검증에 실패하면 설치하지 않는다. 서버가 아니라 GitHub raw 에서 받으므로 별도 서버가 필요 없다.
- 설정창에서 자동 업데이트를 끄거나 "지금 업데이트 확인" 을 누를 수 있다.

개인키 `keys/chatlogexporter-sign.key` 는 **제작자 PC에만** 있고 저장소에는 올라가지 않는다(`.gitignore`).

## 새 버전 내기 (제작자용)

소스를 고친 뒤:

```
node tools/push-plugin.mjs            # 뒷자리 +1, 서명, 내 디스코드 반영, GitHub(main) push
node tools/push-plugin.mjs --minor    # 가운데 자리 +1
node tools/push-plugin.mjs --set 3.0.0
node tools/push-plugin.mjs --local    # GitHub 안 올리고 내 PC에만
node tools/push-plugin.mjs --dry      # 미리보기만
```

- 판번호(`@version` 주석 + `this.version`)를 자동으로 같이 올린다.
- 공개키를 플러그인에 주입하고, 문법을 검사하고, 서명(`.sig`)과 `version.json` 을 갱신한다.
- 내 BetterDiscord 폴더에 복사하고 `main` 에 push 한다 → 친구들이 자동으로 받는다.

> `releases/latest/download/Install-ChatLogExporter.cmd` 링크용 릴리스는 **한 번만** 만들면 된다.
> 설치 파일은 항상 `main` 의 최신 플러그인을 받으므로 버전마다 다시 릴리스할 필요가 없다.
