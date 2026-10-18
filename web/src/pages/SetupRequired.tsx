export default function SetupRequired() {
  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <h1>Connect the database</h1>
      <p>This build has no Neon connection yet. Create <span className="code">web/.env.local</span> with your project's public values and rebuild:</p>
      <pre className="code">{`VITE_NEON_AUTH_URL=https://ep-xxx.neonauth.ap-southeast-1.aws.neon.tech/neondb/auth
VITE_NEON_DATA_API_URL=https://ep-xxx.apirest.ap-southeast-1.aws.neon.tech/neondb/rest/v1
VITE_API_URL=https://<your api function URL>`}</pre>
      <p className="muted">These values are public by design; your data is protected by row-level security. See the README for the full setup.</p>
    </div>
  );
}
