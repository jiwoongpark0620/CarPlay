# Carlinkit T2C se CarPlay 클라이언트

Carlinkit T2C se 제품 (FW version x.3751.x)의 web view 문제를 해결하기 위한 클라이언트.
순정 Carlinkit T2C 어댑터의 WebSocket에 직접 붙어서 H.264를 브라우저에서 디코딩하는 경량 클라이언트.
순정 페이지에서 시간이 지날수록 지연이 쌓이는 문제를, 프레임 흐름 제어(모두 디코딩, 최신 것만 그리기)로 막는다.
디코더(`js/video.js`, `js/h264worker.js`, `js/h264dec.js`, `js/h264dec.wasm.txt`)와 프로토콜(`js/protocol.js`)은
[taylor224/cpc200-t2c](https://github.com/taylor224/cpc200-t2c)에서 가져왔다. `protocol.js`만 어댑터 주소를
`wss://tespush.com/`로 고정하도록 수정. 원 저장소에 라이선스 파일이 없으므로 개인 용도로만 사용할 것.

*Apple Carplay 동작을 위해서 제작되었으며, Android Auto에서 동작 여부는 확인하지 않음.

## 사용법
1. Carlinkit을 차량에 세팅 (블루투스 및 WiFi 연결)
2. https://www.tespush.com/ 에 접속하여 Carplay 화면 출력 확인 (화면 잘린 상태)
3. https://jiwoongpark0620.github.io/CarPlay/?mode=picture 로 접속
4. 업데이트가 완료될 동안 잠시 대기

## 2026.10.20. 기준 펌웨어 버전 26081414.3075.1 기준 문제점
화면 잘림: 화면의 우측이 잘려 보이는 문제
누적 딜레이: 카플레이 연결 시 화면 지연시간이 지속적으로 누적되는 문제


## 처음 열 때 일어나는 일
1. 어댑터가 Picture(MJPEG) 모드면 Video(H.264) 모드로 바꾸고 세션을 한 번 재시작한다 (iPhone 재연결 몇 초).
2. 세션 크기 오버라이드를 보내고, 실제로 받은 영상 크기가 다르면 한 번 더 재시작한다.
   그래도 다르면 이 펌웨어가 오버라이드를 무시하는 것으로 보고 이후 `auto`로 고정한다.
3. 순정 페이지로 돌아가면 어댑터는 Video 모드로 남아 있다. 순정 페이지가 검은 화면이면
   순정 설정에서 모드를 다시 Picture로 바꾼다.
