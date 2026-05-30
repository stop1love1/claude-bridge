# Chạy Claude Bridge 24/7 (Windows)

Tính năng **Quy trình** (cron + auto-queue) chỉ hữu ích khi tiến trình bridge
luôn sống. Bridge tự thân không thể tự hồi sinh nếu process chết — đó là việc
của một supervisor ở tầng OS. Trên Windows, cách gọn nhất (không cài thêm gì)
là **Windows Task Scheduler**.

## Cài nhanh (Task Scheduler — khuyến nghị)

Mở PowerShell tại thư mục bridge và chạy:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
```

Script đăng ký một task tên `ClaudeBridge`:

- **Trigger:** chạy khi bạn đăng nhập Windows (`AtLogOn`).
- **Auto-restart:** nếu process thoát/crash, Task Scheduler khởi động lại sau
  mỗi 1 phút (tối đa 999 lần) — tức là "luôn sống".
- **Một bản duy nhất:** `MultipleInstances IgnoreNew` + advisory process-lock
  của bridge đảm bảo không có 2 bridge cùng ghi vào `sessions/`.
- **Log:** stdout/stderr nối vào `.bridge-state\bridge-service.log`.

Khởi động ngay (không cần đăng xuất/đăng nhập lại):

```powershell
Start-ScheduledTask -TaskName ClaudeBridge
```

Kiểm tra trạng thái:

```powershell
Get-ScheduledTask -TaskName ClaudeBridge | Get-ScheduledTaskInfo
```

Gỡ:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -Uninstall
```

> Lưu ý: `AtLogOn` cần phiên đăng nhập của bạn đang mở. Nếu cần bridge chạy cả
> khi không ai đăng nhập (máy chủ headless), dùng NSSM bên dưới để chạy như một
> Windows Service thực thụ.

## Tuỳ chọn: NSSM (Windows Service thật)

NSSM chạy bridge như một service độc lập phiên đăng nhập, có log stream riêng.

1. Tải nssm: <https://nssm.cc/download> và đặt `nssm.exe` lên PATH.
2. Tạo service (chỉnh đường dẫn `bun` và thư mục bridge cho đúng):

   ```powershell
   $bun = (Get-Command bun).Source
   nssm install ClaudeBridge "$bun" "run start"
   nssm set ClaudeBridge AppDirectory "D:\Edusoft\lms.edusoft.vn\claude-bridge"
   nssm set ClaudeBridge AppStdout "D:\Edusoft\lms.edusoft.vn\claude-bridge\.bridge-state\bridge-service.log"
   nssm set ClaudeBridge AppStderr "D:\Edusoft\lms.edusoft.vn\claude-bridge\.bridge-state\bridge-service.log"
   nssm set ClaudeBridge Start SERVICE_AUTO_START
   nssm start ClaudeBridge
   ```

3. Gỡ: `nssm stop ClaudeBridge; nssm remove ClaudeBridge confirm`.

## Sau khi cài

- Mở **Quy trình** trong UI để xem panel **Trạng thái 24/7** (PID, uptime,
  tick gần nhất), bật **auto-queue** + đặt **trần đồng thời**, và tạo các lịch
  **cron**.
- Scheduler chỉ chạy trên đúng tiến trình giữ process-lock, nên dù Task
  Scheduler có lỡ chạy 2 bản thì cũng không double-dispatch.
- Mọi task do scheduler/cron tạo đều dừng ở **READY FOR REVIEW** — không bao
  giờ tự đánh dấu DONE; bạn vẫn là người duyệt.
