# GazeAware Record Extension

논문 실험용 웹 브라우징 recorder의 초기 Chrome extension 골격입니다. 현재 버전은 Chrome viewport emulation으로 웹페이지의 viewport 크기를 고정하고, 일반 wheel/touch scroll을 막은 뒤 `ArrowUp` / `ArrowDown` 입력으로만 일정량 이동하도록 만듭니다.

## 현재 기능

- Chrome Manifest V3 extension
- 기본 viewport 크기: `1080 x 720`
- Chrome Debugger Protocol 기반 viewport emulation
- 페이지 DOM/CSS에 script/style/frame을 삽입하지 않는 CSP 친화적 방식
- native scrollbar 숨김
- wheel, trackpad, touch scroll 차단
- `ArrowDown` / `ArrowUp` 1회 입력당 일정 입력값 (기본`120px`) 즉시 이동
- 키를 꾹 누를 때 발생하는 반복 scroll 차단
- 새 탭 링크를 같은 탭 이동으로 강제
- 페이지 로드와 interaction 로그 저장
- popup에서 `User ID`, `Task ID`, viewport 설정 저장
- 저장 시 아래 구조 생성

```text
task_logs/
  User <N>/
    completed_tasks.txt
    <task_id>/
      setup.json
```

웹 로그는 선택한 `Log Folder` 아래에 아래 구조로 저장됩니다. 폴더를 선택하지 않으면 Chrome 기본 다운로드 폴더 아래에 생성됩니다.

```text
web_logs/
  web_tab<n>_<ts>.json
  web_tab<n>_<ts>.html
  web_tab<n>_<ts>.css
  web_tab<n>_<ts>_a11y_tree.json
  web_tab<n>_<ts>.png
  web_tab<n>_<ts>_scroll_<k>.png
```

`web_tab<n>_<ts>.json`에는 `url`, `title`, `order`, `created_at`, `dom_file`, `web_css`, `a11y_file`, `interaction`이 저장됩니다. `interaction`에는 `page`, `scrollTop`, `scrollBottom`, `click` 이벤트가 append됩니다.

## Chrome 개발자 모드에서 사용하기

1. Chrome에서 `chrome://extensions/`를 엽니다.
2. 오른쪽 위 `Developer mode`를 켭니다.
3. `Load unpacked`를 누릅니다.
4. 이 폴더를 선택합니다.
   - `~/RecordExtension`
5. extension 아이콘을 눌러 popup을 엽니다.
6. `Log Folder`를 눌러 로그를 만들 로컬 폴더를 선택합니다.
   - 이 프로젝트 폴더 안에 `task_logs/`를 만들고 싶다면 위 폴더를 그대로 선택하세요.
   - 폴더를 선택하지 않으면 Chrome 기본 다운로드 폴더 아래에 `task_logs/` 파일들이 생성됩니다.
7. `User ID`, `Task ID`를 입력하고 viewport toggle을 켠 뒤 `Save Setup`을 누릅니다.
8. 실험할 웹페이지를 열거나 새로고침하면 viewport emulation이 적용됩니다.

`debugger` 권한을 사용하므로 Chrome 상단에 이 extension이 브라우저를 디버깅한다는 안내가 표시될 수 있습니다. Walmart처럼 CSP가 강한 사이트에서 페이지 DOM을 직접 변경하지 않기 위한 선택입니다.

코드를 수정한 뒤에는 `chrome://extensions/`에서 이 extension의 reload 버튼을 누르고, 실험할 웹페이지도 새로고침하세요.

## 참고한 구조

A11y-CUA `Computer-Use-Recorder`는 Windows desktop recorder이며 OBS, 로컬 Python 서버, accessibility tree, Chrome extension web logger를 함께 사용합니다. 이 프로젝트는 그중 task output structure와 Chrome extension loading 방식만 웹 전용 extension 형태로 가져온 초기 버전입니다.
