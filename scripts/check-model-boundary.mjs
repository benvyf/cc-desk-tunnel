import { fileURLToPath } from 'node:url';
import { assertDesktopModelBoundary } from './model-boundary.mjs';

assertDesktopModelBoundary(fileURLToPath(new URL('..', import.meta.url)));
console.log('PASS：客户端模型运行依赖和导入边界检查通过。');
