export const metadata = {
  title: 'API Documentation',
};

export default function ApiDocPage() {
  return (
    <main style={{ width: '100vw', height: '100vh', margin: 0, padding: 0, overflow: 'hidden' }}>
      <iframe 
        src="/radion/api/docs" 
        style={{ width: '100%', height: '100%', border: 'none' }}
        title="Swagger API Documentation"
      />
    </main>
  );
}