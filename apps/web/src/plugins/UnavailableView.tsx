import { Trans } from '@lingui/react/macro';

export function UnavailableView() {
  return <p className="p-3 text-sm text-fg-3" role="status"><Trans>当前客户端版本不兼容</Trans></p>;
}
