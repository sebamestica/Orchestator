// Las pruebas con repos git reales corren en un solo archivo (un solo worker, en serie):
// en Windows cada git.exe es caro y, repartidas en varios workers, ahogaban al resto de la suite.
import './manager.cases.ts';
import './integrate.cases.ts';
import './push-block.cases.ts';
import './review-agy.cases.ts';
import './hardening.cases.ts';
