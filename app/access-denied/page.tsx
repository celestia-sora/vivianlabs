const LOGIN_URL = "https://vivianauth.celestiasora.workers.dev/login";

export default function AccessDeniedPage(): React.JSX.Element {
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "#e0d6ff", color: "#241329" }}>
      <section style={{ width: "min(100%, 440px)", padding: 32, borderRadius: 24, background: "#fffaf2", boxShadow: "0 18px 60px #24132920", textAlign: "center" }}>
        <div aria-hidden="true" style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
        <h1 style={{ margin: "0 0 12px", fontSize: 26 }}>เข้าบัญชีนี้ยังไม่ได้แฮะ</h1>
        <p style={{ margin: "0 0 24px", lineHeight: 1.7, color: "#5f5470" }}>
          Vivian ให้เข้าเฉพาะบัญชีที่ยืนยันอีเมลเรียบร้อยแล้วเท่านั้นน้า (บัญชีแบบ Guest เข้าไม่ได้อะ) ลองไปกดยืนยันอีเมล หรือสลับล็อกอินอีกบัญชีดูนะ!
        </p>
        <a href={LOGIN_URL} style={{ display: "inline-block", padding: "12px 20px", borderRadius: 14, background: "#6f4b8b", color: "white", textDecoration: "none", fontWeight: 600 }}>
          กลับไปหน้าล็อกอิน
        </a>
      </section>
    </main>
  );
}
