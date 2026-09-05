# Local deploy 0.4.0

Prompt Claude Code: **“Đưa dự án này lên MONA Cloud, dùng thư mục hiện tại”**.

`local_dir` nằm trên máy chạy MCP; dùng đường dẫn tuyệt đối khi MCP host có cwd khác editor. Không cần git, remote hoặc commit. CLI cùng máy gọi đúng các tool này qua stdio, dùng cùng cơ chế ZIP và MONA Pass.

| Tool | Hợp đồng |
|---|---|
| `cloud_app_detect({local_dir})` | Chỉ đọc local: `{local_dir,name,stack,port,start_command,dockerfile,build_type,env_required,warnings,network:false}`. Stack node/next/vite/python/php/static; `env_required` là tên biến trong `.env.example`, không gồm giá trị. Lệnh start là gợi ý cần AI xác minh. |
| `cloud_app_create({local_dir,name?,build_type?,env?,port?,domain?,sandbox?,wait?,interval_sec?,timeout_sec?})` | POST `/api/apps` JSON `{source:"upload",name,build_type,env,port,domain?}` → `{id,upload_url,max_bytes}` → POST multipart upload → poll job |
| `cloud_app_deploy({app_id,local_dir?,sandbox?,wait?,interval_sec?,timeout_sec?})` | Có local_dir: GET app, yêu cầu source=upload, ZIP mới → upload → chờ upload done/succeeded → POST deploy → poll. Không local_dir: POST deploy dùng source đã lưu. |

Mỗi tool có alias `vibecloud_` cùng schema/handler. Tổng 135 tool, 2 resource, 2 prompt. Phiên bản package, binary và handshake là 0.4.0.

Upload gửi đúng POST `/api/apps/{id}/upload`, FormData gồm `archive` (file `project.zip`, MIME `application/zip`) và `build_path` (`.`). ZIP chứa nội dung thư mục ở root, không bọc thêm tên thư mục. Fetch tự sinh multipart boundary, dùng token compute hiện tại; upload không follow redirect. `upload_url` phải đúng endpoint cùng origin, không gửi ZIP/token sang host khác. Nếu server trả `max_bytes` nhỏ hơn giới hạn local, MCP dừng upload và giữ app_id cho lần sửa tiếp.

Create upload chờ job upload/build và trả `{url,app_id,build,seconds}` cùng status/job_id. `build` giữ dữ liệu API; nếu API không có thì dùng trạng thái build/job. `seconds` giữ số API trả hoặc thời gian xử lý request khi chưa có. `wait:false` có thể trả job queued và chưa có URL; với redeploy có source mới, MCP vẫn phải chờ job upload trước khi gửi deploy. Job upload timeout trả `phase:"upload"`: poll job đó rồi gọi deploy không local_dir. Không tự retry POST hoặc tạo app khác.

## ZIP và nhận diện offline

- Không cài dependency, chạy shell, thực thi code dự án hoặc gửi mạng trong detect/ZIP.
- Giới hạn ZIP local **83,886,080 bytes (80 MiB)**, tính cả header/central directory; kiểm trước HTTP. ZIP32 deflate, UTF-8 filenames, giữ bit executable. Giới hạn ZIP32: 65,535 file, 4 GiB mỗi file.
- Luôn loại `node_modules`, `.git`, `.env*` (kể cả `.env.example`), `*.pem` ở mọi cấp và mọi symlink. Ignore negation không thể đưa các file này trở lại.
- Áp dụng `.gitignore` ở root và thư mục con, `.dockerignore` ở root. Hai bộ rule cùng áp dụng: file phải được cả hai cho phép. Hỗ trợ `*`, `**`, `?`, character classes, comments, anchored paths và negation `!`. Git không re-include được file nếu thư mục cha vẫn bị exclude; Docker cho phép `!dir/file` dưới thư mục excluded.
- `dist` không tự loại: Dockerfile có thể `COPY dist`. Chỉ thêm `dist` vào ignore khi build có thể tạo lại nó. File được ignore theo cấu hình dự án vẫn bị bỏ.
- Metadata/ignore file tối đa 1 MiB; lỗi đọc/JSON/ignore/ZIP báo lỗi rõ ràng, không upload một phần. Không sinh archive tạm trên đĩa.
- Dockerfile root gợi ý `dockerfile`; không có Dockerfile thì Node/Next/Vite/Python/PHP gợi ý `nixpacks`, static gợi ý `static`. Port ưu tiên EXPOSE, port trong scripts.start, rồi mặc định stack. AI cần xác minh start và bind `0.0.0.0`.

## AI làm 99%, duyệt chi phí một lần

Detect → đọc app host/giá giờ hoặc gói và ví → sandbox nếu chưa có host → báo estimate để human duyệt một lần → create local thật → poll, kiểm và trả URL. Host hiện có tiếp tục tính phí theo kỳ đang dùng; host chưa ready thì cần start trước. Human đăng ký MONA Pass/device flow và nạp ví khi hết credit 20k. Có domain riêng: `cloud_app_domain_add`, đưa CNAME từ API và kiểm DNS/HTTPS.

Nếu gọi create local thật khi chưa có host và chưa có preview hợp lệ trong MCP session, MCP chỉ chạy sandbox và trả `needs_cost_approval:true`. Preview cùng thư mục/cấu hình có estimate terminal được giữ 10 phút trong session. Sau khi agent đã lấy duyệt chi phí, gọi lại cấu hình đó với `sandbox:false`; nếu preview hết hạn, báo lại estimate trước khi tiếp tục. Sandbox explicit hoặc `MONACLOUD_SANDBOX=1` luôn 0đ, không đọc Billing. Backend sandbox cũ trả thẳng job estimate cũng được hỗ trợ.

Lỗi upload/build sau create có app_id trong `next_step`; sửa rồi dùng `cloud_app_deploy` với cùng app_id/local_dir. 409 `upload_required` hướng dẫn upload lại bằng tool deploy. 402 hướng dẫn nạp ví. Không báo URL sandbox hoặc job đang chạy là website thật.

## Tương thích git

`cloud_app_create({repo_url,branch?,build_type?,dockerfile?,env?,domain?,app_host_id?,port?})` giữ mặc định main/dockerfile/Dockerfile/3000 như 0.3.x. Chọn đúng một `local_dir` hoặc `repo_url`. `branch`, `app_host_id` và Dockerfile tuỳ chỉnh chỉ áp dụng git; backend upload tự chọn host theo tài khoản, dùng Dockerfile root. Không đổi tên field hợp đồng backend trong brief ngày 05/09/2026.

Tất cả kiểm chứng bản này dùng local test và HTTP mock; không gọi production và không publish.
