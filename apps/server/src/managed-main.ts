import { enforceManagedDeployment } from './native-deployment.ts';

enforceManagedDeployment(process.env);
await import('./main.ts');
