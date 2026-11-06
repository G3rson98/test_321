import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/popover';
import { createQueryClient } from '@/lib/query/client';
import { createAppRouter } from './router';

export function App() {
  const [queryClient] = useState(() => createQueryClient());
  const [router] = useState(() => createAppRouter(queryClient));
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <RouterProvider router={router} />
        <Toaster position="bottom-right" richColors closeButton toastOptions={{ className: 'font-sans' }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
