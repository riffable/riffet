import { useStore } from '@/lib/store';
import { useStores } from '../state/stores';
import type { TabsState } from './tabsStore';

export const useTabs = <S,>(selector: (state: TabsState) => S, isEqual?: (a: S, b: S) => boolean): S => useStore(useStores().tabs, selector, isEqual);
