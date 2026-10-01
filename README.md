# Hugo Boss PKL Weight Sync

Trang web cập nhật trọng lượng thực tế (Packing List SCAVI) vào Packlist Hugo Boss.

## Cách dùng
1. Mở trang, thả Packlist Hugo Boss và Packing List SCAVI (PDF) vào 2 ô (hoặc thả cả 2 file cùng lúc).
2. Bấm **Cập nhật trọng lượng**, kiểm tra bảng đối chiếu.
3. Bấm **Tải PDF Hugo Boss đã cập nhật**.

## Quy tắc
- Ghép thùng theo PO Item + Style + màu + cơ cấu size/số lượng, theo thứ tự thùng.
- Weight từng thùng = G.W (Kg) của SCAVI; thùng đóng ghép chỉ lấy 1 giá trị.
- Tổng TR item = cộng trọng lượng mới; tổng cộng & Gross Weight = Total CI Gross Weight; Net Weight = Total CI Net Weight.
- Số cũ được xoá khỏi lớp chữ của PDF, không chỉ phủ trắng.
- Xử lý hoàn toàn trên trình duyệt (pdf.js + pdf-lib), không gửi file đi đâu.

## Đưa lên GitHub Pages
1. Tạo repository mới trên GitHub (ví dụ `hugo-pkl-weight`).
2. **Add file → Upload files**, kéo toàn bộ nội dung thư mục này (gồm `index.html`, `pkl-core.js`, thư mục `lib/`, `.nojekyll`) vào, bấm Commit.
3. **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main`, thư mục `/ (root)` → Save.
4. Sau khoảng 1 phút, trang chạy tại `https://<tên-tài-khoản>.github.io/hugo-pkl-weight/`.
