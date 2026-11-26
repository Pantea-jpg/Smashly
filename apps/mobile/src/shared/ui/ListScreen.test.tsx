import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { ThemeProvider } from '../theme/ThemeProvider';
import { ListScreen } from './ListScreen';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `row-${String(i)}` }));

async function renderList(data: { id: string }[]) {
  await render(
    <ThemeProvider>
      <ListScreen
        testID="list"
        data={data}
        keyExtractor={(r) => r.id}
        renderItem={(r) => <Text testID={r.id}>{r.id}</Text>}
        isPending={false}
        error={null}
        emptyMessage="Nothing yet"
        onRefresh={jest.fn()}
        refreshing={false}
      />
    </ThemeProvider>,
  );
}

describe('ListScreen performance', () => {
  it('virtualizes: a 500-row history mounts only the first screenful', async () => {
    await renderList(rows(500));
    expect(screen.getByTestId('row-0')).toBeOnTheScreen();
    const mounted = screen.queryAllByText(/^row-\d+$/).length;
    expect(mounted).toBeGreaterThanOrEqual(10);
    expect(mounted).toBeLessThanOrEqual(24); // initialNumToRender + one batch, never 500
    expect(screen.queryByTestId('row-499')).toBeNull();
  });
});
