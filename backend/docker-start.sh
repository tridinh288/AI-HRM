#!/bin/sh
# Khởi động cho bản demo: tự dựng database rồi mới chạy server.
#
# Không phải cách deploy một hệ thống thật. Ở đó migration là một bước riêng,
# chạy một lần, có người nhìn — lý do viết trong src/db/migrate.js. Cách này chỉ
# đúng khi có duy nhất một instance, như gói free của Render: nhiều instance thì
# chúng tranh nhau alter cùng một bảng.
#
# Seed ở đây an toàn vì nó tự từ chối động vào database đã có tài khoản. Lần
# khởi động đầu nó dựng cả công ty; những lần sau nó in một dòng rồi thoát.
set -e

node dist/db/migrate.js
node dist/db/seed.js

# `exec` để server thay thế luôn shell này, nhờ vậy SIGTERM đi thẳng tới Node.
# Không có nó, shell nhận tín hiệu còn server thì không, và đoạn tắt êm trong
# server.ts không bao giờ chạy khi container bị dừng.
exec node dist/server.js
