# Changelog

## v3.0.0 (2026-11-28)

สรุปการอัปเดตหลักตั้งแต่ `v2.6.0`:

- **Dual Live2D + 3D Avatar System:** เพิ่มโหมดตัวละคร 3D (`.vrm` 0.x/1.0, `.vrma`, `.fbx`) สลับกับ Live2D ได้สะอาดไม่รั่วหน่วยความจำ รองรับแสงโหมด Anime / Realistic PBR, FastFBXLoader และซิงก์ Cloud R2
- **3D Physics Engine:** ระบบฟิสิกส์ผม/เสื้อผ้าแบบ Framerate-independent (30–120Hz), ลมพัดแยกช่อ, แรงเฉื่อยตอนลาก/แตะตัวละคร, Auto Body Colliders และ Verlet physics สำหรับโมเดล FBX
- **24-Pose Semantic Motion Library & Live Preview UI:** ท่าทาง Semantic 24 ท่า (4 หมวด) ด้วย Zero-Twist IK + ล็อกองศาข้อต่อ, ซิงก์สีหน้าและสายตาอัตโนมัติ, สลับท่าสมูท และหน้าต่างตั้งค่าตัวละครแบบ **พรีวิวสด** ไม่บังตัวละคร (พร้อมแก้บั๊กสีหน้า VRM รีโหลด)
- **Voice, STT & Persona:** อัปเกรด ElevenLabs STT เป็น Scribe v3 Live, จูน ElevenLabs v4 audio tags + คำพูดซึนเดเระให้เป็นธรรมชาติขึ้น และจำกัด Custom Voice ID เฉพาะ Sorachan tier
- **Memory, Stability & Security:** เพิ่มสรุปความจำบนหน้าเว็บและปรับปรุงการดึงความจำภาษาไทย, แก้ลูป retry ของแชตคลาวด์ที่ลบแล้ว, ข้าม URL ฉากที่หมดอายุ และเสริมความปลอดภัยฐานข้อมูล/ESLint
