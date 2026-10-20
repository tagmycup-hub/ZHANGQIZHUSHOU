/** 记录应用内导航方向：返回时恢复列表的筛选和滚动位置，前进时从头开始 */
const stack: string[] = [typeof location === 'undefined' ? '' : location.hash];
let back = false;
const pageState = new Map<string, unknown>();

export function onHashChange(hash: string) {
  if (stack.length >= 2 && stack[stack.length - 2] === hash) {
    stack.pop();
    back = true;
  } else {
    stack.push(hash);
    back = false;
  }
}
export function onReplace(hash: string) {
  stack[stack.length - 1] = hash;
  back = false;
}
export const isBackNav = () => back;

export function savePageState<T>(key: string, v: T) {
  pageState.set(key, v);
}
/** 只有返回到这个页面时才取回之前的状态 */
export function restorePageState<T>(key: string): T | undefined {
  return back ? (pageState.get(key) as T | undefined) : undefined;
}
