// the compile cache has to be on before the other modules load, so they come in through a dynamic import
import { enableCompileCache } from 'node:module';

enableCompileCache();
await import('./main.ts');
