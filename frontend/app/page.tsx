import { Suspense } from "react";
import { CertificateForm } from "./certificate-form";
import { CertificateList, CertificateListSkeleton } from "./certificate-list";

export default function Home() {
  return (
    <main className="mx-auto grid w-full max-w-5xl flex-1 gap-10 px-4 py-10 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section aria-labelledby="new-certificate" className="flex flex-col gap-4">
        <h2 id="new-certificate" className="text-lg font-semibold">
          Nuevo certificado
        </h2>
        <CertificateForm />
      </section>

      <section aria-labelledby="certificates" className="flex flex-col gap-4">
        <h2 id="certificates" className="text-lg font-semibold">
          Certificados
        </h2>
        <Suspense fallback={<CertificateListSkeleton />}>
          <CertificateList />
        </Suspense>
      </section>
    </main>
  );
}
