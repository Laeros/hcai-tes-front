import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

/**
 * Convierte `rem` a `px` (1rem = 16px). Dentro del Shadow DOM `rem` sigue siendo relativo al
 * <html> de Google Classroom; con px el widget no cambia de tamaño si la página altera su font-size.
 */
const remToPx = () => ({
  postcssPlugin: 'hcai-rem-to-px',
  Declaration(decl) {
    if (decl.value.includes('rem')) {
      decl.value = decl.value.replace(/(-?\d*\.?\d+)rem/g, (_, n) => `${parseFloat(n) * 16}px`);
    }
  },
});
remToPx.postcss = true;

export default {
  plugins: [tailwindcss(), autoprefixer(), remToPx()],
};
