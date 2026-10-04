import { EmptyState, Page } from '@d3cloud/ui';

/** Replaced by the projects list (FLR-T-0.8). */
export function Home() {
  return (
    <Page>
      <EmptyState kind="empty" heading="No projects yet">
        Projects arrive next.
      </EmptyState>
    </Page>
  );
}
