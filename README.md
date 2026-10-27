# DomainGuard Web v0.3

Website kiểm tra tên miền giả mạo (Unicode giả Latin + tên miền Latin dễ nhầm), tự động đồng bộ 5.000 tên miền tham chiếu:
- 2.000 tên miền phổ biến tại Việt Nam từ Cloudflare Radar
- 3.000 tên miền phổ biến toàn cầu từ Tranco (bỏ qua tên miền đã trùng với danh sách Việt Nam)
- Cộng thêm 31 tên miền mẫu trong `config/base_domains.json` (ngân hàng, ví điện tử, sàn TMĐT Việt Nam...)

## Yêu cầu
- Node.js 18 trở lên (không cần `npm install`)
- Cloudflare API token có quyền đọc Radar (tạo tại dash.cloudflare.com > My Profile > API Tokens)

## Chạy trên Windows (cmd)
```
cd DomainGuard-Web
set CF_API_TOKEN=token_cua_ban
node server.js
```
Mở http://localhost:3000. Máy chủ đồng bộ ngay khi khởi động và lặp lại mỗi 24 giờ (sửa trong `config/sources.json`).
Kết quả lưu ở `data/domains.json`; nếu lần đồng bộ sau lỗi, website tiếp tục dùng bản lưu gần nhất.

## Cấu hình (JSON)
- `config/sources.json`: số lượng lấy từ mỗi nguồn, quốc gia, chu kỳ đồng bộ, cổng.
- `config/exclude_domains.json`: tên miền hạ tầng/CDN bị loại (googleapis.com, akamai.net...).
- `config/base_domains.json`: danh sách mẫu luôn được thêm vào.

## Kiểm thử
```
node test/run.js
```

## Lưu ý
- "Phổ biến" không đồng nghĩa "uy tín". Cloudflare cho biết danh sách top có thể chứa tên miền độc hại.
- Nếu Cloudflare Radar trả về ít hơn 2.000 dòng (giới hạn API), dòng trạng thái trên website sẽ hiện số thực tế.
- Lỗi font: toàn bộ văn bản được chuẩn hoá Unicode NFC (dấu dựng sẵn) và dùng font Be Vietnam Pro, dự phòng Segoe UI/Arial.

## Quy tắc cảnh báo (v0.3.1)
- Có ký tự ngoài Latin **không** tự động bị cảnh báo.
- Cảnh báo khi: (1) giống/gần giống tên miền trong danh sách tham chiếu, hoặc (2) sau khi chuyển sang Latin, tên miền Latin đó đang tồn tại (tra cứu DNS).
- Chuyển sang Latin mà không tìm thấy tên miền nào: hiển thị "chưa phát hiện", không cảnh báo.
- Không tra cứu được DNS: hiển thị "chưa kết luận được".
- Tên miền Latin được xác định xấp xỉ (có hậu tố hai cấp như com.vn thì lấy 3 nhãn cuối); chưa dùng Public Suffix List.

## Báo cáo cộng đồng + đăng nhập Google (v0.4)

Tra cứu không cần đăng nhập. Chỉ khi bấm **Báo cáo đáng ngờ**, người dùng mới đăng nhập Google. Mỗi Firebase UID chỉ có một bản ghi cho mỗi tên miền. Nếu engine đang xanh nhưng có ít nhất một báo cáo, kết quả chuyển sang vàng; mức đỏ của engine luôn được giữ.

### Cấu hình Firebase
1. Tạo Firebase project và đăng ký **Web app**.
2. Authentication > Sign-in method > bật **Google**.
3. Authentication > Settings > Authorized domains > thêm hostname Render, ví dụ `domainguard-web.onrender.com` (không có `https://`).
4. Realtime Database > Create database.
5. Dán cấu hình Web app Firebase vào `public/firebase-config.js`.
6. Realtime Database > Rules > dán nội dung `database.rules.json` rồi Publish. Không dùng Test mode lâu dài.

Để bot Zalo cũng đọc số report, thêm vào Render Environment:

```
FIREBASE_DATABASE_URL=<databaseURL Firebase cung cấp>
```

Không tự đoán URL. Website dùng `public/firebase-config.js`; bot dùng biến môi trường trên.

### Dữ liệu và bảo mật
- Dữ liệu: `reports/<base64url-domain>/<firebase-uid> = { uid, domain, reason, createdAt }`.
- Không lưu email hoặc tên Google trong báo cáo.
- Firebase web config là cấu hình công khai; không đặt service-account JSON, refresh token hoặc private key vào repo.
- Rules cho phép công khai đọc nhánh report để website và bot đếm; chỉ người đăng nhập mới ghi tại UID của mình.
- Google Login chỉ giảm spam cơ bản. Khi mở rộng nên thêm Firebase App Check, kiểm duyệt và quy trình kháng nghị/gỡ nhãn.


### Đăng nhập/đăng xuất, thu hồi báo cáo, khoá theo thiết bị (v0.5)
- Header có nút **Đăng nhập / Đăng xuất**. Chỉ thao tác báo cáo mới cần đăng nhập; đã đăng nhập thì báo cáo tiếp không hỏi lại.
- Tài khoản đã báo cáo tên miền thì nút đổi thành **Thu hồi báo cáo của bạn** (làm được trên bất kỳ thiết bị nào, chỉ với báo cáo của chính mình).
- Mỗi thiết bị chỉ có **một báo cáo đang hiệu lực cho mỗi tên miền**. Nếu tài khoản A đã báo cáo X trên thiết bị này, tài khoản B trên cùng thiết bị không báo cáo X được (nút mờ) cho tới khi A thu hồi. B vẫn báo cáo tên miền khác.
- Thiết bị = ID ngẫu nhiên trong localStorage của trình duyệt; chỉ bản băm SHA-256 được gửi lên Firebase. Xoá dữ liệu trình duyệt, dùng chế độ riêng tư hoặc trình duyệt khác sẽ tạo thiết bị mới: đây là lớp chống spam cơ bản, không tuyệt đối. Khi mở rộng nên thêm Firebase App Check.
- Dữ liệu mới: `reportLocks/<domain>/<deviceKey> = {uid, createdAt}` (khoá thiết bị) và `userReports/<uid>/<domain> = {deviceKey, createdAt}` (chỉ chủ tài khoản đọc được, dùng để thu hồi từ thiết bị khác). **Bắt buộc dán lại `database.rules.json` vào Firebase Console > Realtime Database > Rules rồi Publish.**
- Khi kết quả màu xanh, trang hiển thị thông tin đăng ký công khai (chủ sở hữu nếu có, nhà đăng ký, ngày đăng ký, hết hạn) lấy từ RDAP qua `/api/domain-info`. Nhiều tên miền ẩn chủ sở hữu; một số đuôi có thể không có dữ liệu RDAP.
- Biến môi trường tuỳ chọn: `RDAP_API_BASE` (mặc định https://rdap.org/).
- Kiểm thử: `node test/community.test.js` và `node test/device-lock.test.js` (mô phỏng, không thay thế thử trên Firebase thật).
### Danh sách đen (blacklist) miễn phí (v0.6)

Máy chủ tải sẵn các danh sách đen về `data/blacklist.json` và tra cứu **ngay trên máy chủ**: địa chỉ người dùng nhập **không** bị gửi cho bên thứ 3.
Nếu địa chỉ có trong danh sách đen, kết quả luôn là **🚨 đỏ** (trên web và bot Zalo), kèm tên nguồn và hướng dẫn xử lý.

| Nguồn | Loại | Cần đăng ký | Cập nhật nguồn | Ghi chú |
|---|---|---|---|---|
| OpenPhish Community | URL lừa đảo | Không | ~12 giờ | Chỉ dùng phi thương mại |
| Phishing.Database (ACTIVE) | Tên miền lừa đảo | Không | Vài giờ | Danh sách lớn, đã lọc các dòng lỗi (vd `com`) |
| URLhaus (abuse.ch) | URL mã độc | Auth-Key miễn phí | 5 phút | Chỉ bật khi có `URLHAUS_AUTH_KEY` |

#### Bật URLhaus (tuỳ chọn)
1. Đăng ký tài khoản tại abuse.ch Authentication Portal và tạo Auth-Key.
2. Render > Environment: thêm `URLHAUS_AUTH_KEY=<key>`, rồi deploy lại.
Key không bao giờ xuất hiện trong log (đã được che).

#### Cấu hình (`config/sources.json` > `blacklist`)
- `refreshHours`: chu kỳ tải lại (mặc định 6 giờ).
- `maxPerFeed`: số dòng tối đa mỗi nguồn (giới hạn RAM; mặc định 300.000).
- `feeds`: đặt `false` để tắt từng nguồn.

#### Chống cảnh báo nhầm
- Dịch vụ lưu trữ dùng chung (github.io, sites.google.com, pages.dev, vercel.app, bit.ly...) **không** bị gắn cờ cả tên miền, chỉ gắn cờ đúng subdomain/URL bị liệt kê.
- Tên miền trong danh sách tham chiếu (thương hiệu bảo vệ + Tranco/Cloudflare) chỉ bị gắn cờ khi **đúng URL** nằm trong danh sách đen.
- Nguồn nào tải lỗi thì giữ dữ liệu cũ của nguồn đó.

#### API mới
- `GET /api/blacklist?url=<địa chỉ>` → `{ listed, matches:[{type:'url'|'host', value, sources}], sources, updatedAt }`
- `GET /api/domains` có thêm trường `blacklist` (trạng thái từng nguồn).

#### Kiểm thử
`node test/blacklist.test.js` (offline, không cần mạng)
