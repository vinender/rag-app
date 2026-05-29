import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RAG App — Ask your PDFs',
  description: 'Upload a PDF and ask questions using semantic search + AI.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
