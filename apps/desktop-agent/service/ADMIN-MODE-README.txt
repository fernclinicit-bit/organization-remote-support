Organization Remote Support - Windows Admin Mode
================================================

1. แตกไฟล์ ZIP ไปยังโฟลเดอร์ชั่วคราวในเครื่องปลายทาง
2. คลิกขวา PowerShell แล้วเลือก Run as administrator
3. รัน:
   Set-ExecutionPolicy -Scope Process Bypass
   .\Install-AdminMode.ps1
4. Agent จะเปิดผ่าน Scheduled Task แบบ Highest privileges และ Service จะดูแลให้ Agent พร้อมใช้งาน
5. ทุก session ยังต้องกรอกรหัสและยินยอมบน Agent ตามปกติ
6. เมื่อรับไฟล์ .exe หรือ .msi ผู้ใช้ที่หน้าเครื่องต้องกดยืนยันก่อนเริ่มติดตั้ง Remote input จะถูกปิดระหว่างการยืนยัน

ข้อจำกัดและความปลอดภัย
- ระบบนี้ไม่ปิดและไม่แก้ค่า UAC
- ไม่รองรับการสั่งติดตั้งแบบเงียบหรือรันคำสั่ง arbitrary จาก Controller
- ผู้ใช้ Windows ที่เข้าสู่ระบบต้องเป็นสมาชิก Local Administrators เพื่อให้ RunLevel Highest มีสิทธิ์ผู้ดูแล
- ควรเซ็น Agent, Service และแพ็กเกจติดตั้งด้วยใบรับรอง Code Signing ขององค์กรก่อนใช้งานจริง

ถอนการติดตั้ง
- เปิด PowerShell แบบ Administrator
- รัน C:\Program Files\Organization Remote Support\Uninstall-AdminMode.ps1
