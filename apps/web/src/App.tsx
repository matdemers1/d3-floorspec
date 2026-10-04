import { EmptyState, ThemeProvider } from '@d3cloud/ui';
import { PRODUCT_NAME } from './lib/product';

export function App() {
  return (
    <ThemeProvider>
      <EmptyState kind="empty" heading={PRODUCT_NAME}>Scaffolding only.</EmptyState>
    </ThemeProvider>
  );
}
