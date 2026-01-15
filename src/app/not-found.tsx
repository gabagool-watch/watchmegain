import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh]">
      <h1 className="text-6xl font-bold text-surface-300 mb-4">404</h1>
      <h2 className="text-2xl font-semibold text-surface-100 mb-2">
        Page Not Found
      </h2>
      <p className="text-surface-400 mb-6">
        The page you&apos;re looking for doesn&apos;t exist.
      </p>
      <Link href="/" className="btn-primary">
        Go Home
      </Link>
    </div>
  );
}
