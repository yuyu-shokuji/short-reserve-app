import ReserveApp from '@/components/ReserveApp';

export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-50">
      <ReserveApp />
    </main>
  );
}
