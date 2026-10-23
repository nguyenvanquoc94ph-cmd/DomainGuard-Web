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
