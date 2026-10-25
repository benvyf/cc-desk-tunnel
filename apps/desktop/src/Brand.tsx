import brand from '../brand.json' with { type: 'json' };

export const productName = brand.name;

export default function Brand({
  connectionName,
  className = '',
}: {
  connectionName?: string;
  className?: string;
}) {
  return (
    <span className={`brand brand-lockup ${className}`}>
      <svg className="brand-mark" viewBox="0 0 116 237.21" aria-hidden="true" focusable="false">
        <path d="M116 29.07L36.5 68.82A19 19 0 0 0 26 85.81L26 116.83A2 2 0 0 0 28.89 118.62L52.5 106.82L52.5 135.89L40.52 141.88A28 28 0 0 1 0 116.83L0 85.81A45 45 0 0 1 24.88 45.56L116 0Z" />
        <path d="M63.5 101.32L75.48 95.33A28 28 0 0 1 116 120.37L116 151.4A45 45 0 0 1 91.12 191.64L0 237.21L0 208.14L79.5 168.39A19 19 0 0 0 90 151.4L90 120.37A2 2 0 0 0 87.11 118.58L63.5 130.39Z" />
      </svg>
      <span className="brand-copy">
        <span className="brand-name">{productName}</span>
        {connectionName && (
          <span className="brand-connection" title={connectionName}>
            {connectionName}
          </span>
        )}
      </span>
    </span>
  );
}
