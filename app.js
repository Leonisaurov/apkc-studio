// apkc studio — genera el proyecto, manda la salida de apkc a texto legible y guarda
// dónde se atasca quien lo usa. Sin dependencias: lo que hace falta para escribir el zip
// es un CRC32 y una cabecera local por fichero, nada más.

// ---------------------------------------------------------------- plantillas reales
// Copiadas de apkc/template/* del repo: si apkc cambia una plantilla, está página miente,
// y esa es la única forma en que puede quedar desincronizada con la herramienta.
const TEMPLATES = {
  manifest: `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="{{pkgname}}"
    android:versionCode="1"
    android:versionName="0.1">

    <uses-sdk android:minSdkVersion="{{minsdk}}"
          android:targetSdkVersion="{{targetsdk}}" />

    <application android:label="{{appname}}"{{extras}}>

{{activity}}    </application>
</manifest>
`,
  activity: `package {{pkgname}};

import android.app.*;
import android.os.*;
import android.view.*;
import android.widget.*;
import android.graphics.*;
import android.util.*;
import android.net.*;

public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
    }
}
`,
  layoutButton: `    <Button
        android:id="@+id/pulsar"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="{{button}}"/>

`,
  styles: `<resources>
    <style name="AppTheme" parent="@android:style/Theme.DeviceDefault.Light">
        <item name="android:windowActionBar">false</item>
        <item name="android:windowNoTitle">true</item>
        <item name="android:statusBarColor">#FFFFFF</item>
        <item name="android:windowLightStatusBar">true</item>
        <item name="android:windowBackground">@android:color/white</item>
    </style>
</resources>`,
  layout: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center">

    <TextView
        style="@android:style/TextAppearance.Large"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="{{hello}}"/>

{{button}}</LinearLayout>
`,
  activityButton: `
    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add("{{hello}}").setOnMenuItemClickListener(new MenuItem.OnMenuItemClickListener() {
            public boolean onMenuItemClick(MenuItem item) {
                Toast.makeText(MainActivity.this, "{{toast}}", Toast.LENGTH_SHORT).show();
                return true;
            }
        });
        return true;
    }
`,
  // Plantilla «Contador»: el campo y el listener son el mismo patrón que se midió contra ART
  // (campo privado, anónima que toca un campo del exterior y concatenación de cadenas). El clic
  // escribe en la vista y también en la salida de la app (`Log.d` y `System.out.println`), que es
  // lo que el emulador pinta en su panel de consola.
  activityContador: `package {{pkgname}};

import android.app.*;
import android.os.*;
import android.util.Log;
import android.view.*;
import android.widget.*;

public class MainActivity extends Activity {
    int pulsos = 0;
    TextView total;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
        total = (TextView) findViewById(R.id.total);
        findViewById(R.id.pulsar).setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                pulsos = pulsos + 1;
                total.setText("Pulsos: " + pulsos);
                Log.d("Contador", "pulso " + pulsos);
                System.out.println("contador: pulso " + pulsos);
            }
        });
    }
}
`,
  layoutContador: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center">

    <TextView
        android:id="@+id/total"
        style="@android:style/TextAppearance.Large"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Pulsos: 0"/>

    <Button
        android:id="@+id/pulsar"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="Pulsar"/>
</LinearLayout>
`,
  // «Ciclo»: el mismo onCreate de la plantilla base con un segundo método del ciclo de vida.
  // Solo usa llamadas a super, setContentView y Toast, ya medidas contra javap.
  activityCiclo: `package {{pkgname}};

import android.app.*;
import android.os.*;
import android.widget.*;

public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
        Toast.makeText(this, "Ciclo: onCreate", Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onStart() {
        super.onStart();
        setTitle("Ciclo: onStart");
    }
}
`,
  // «Menú»: onCreateOptionsMenu con la anónima que ya genera la plantilla base cuando lleva botón.
  activityMenu: `package {{pkgname}};

import android.app.*;
import android.os.*;
import android.view.*;
import android.widget.*;

public class MainActivity extends Activity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add("Opciones").setOnMenuItemClickListener(new MenuItem.OnMenuItemClickListener() {
            public boolean onMenuItemClick(MenuItem item) {
                Toast.makeText(MainActivity.this, "Menu pulsado", Toast.LENGTH_SHORT).show();
                return true;
            }
        });
        return true;
    }
}
`,
  // «Traducido»: dos strings con el mismo nombre en values y values-es y una referencia desde el
  // layout. El enlazador en Go ya mide values-es byte a byte contra aapt2 (§94).
  layoutTraducido: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:orientation="vertical"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:gravity="center">

    <TextView
        android:id="@+id/saludo"
        style="@android:style/TextAppearance.Large"
        android:layout_width="wrap_content"
        android:layout_height="wrap_content"
        android:text="@string/saludo"/>
</LinearLayout>
`,
  stringsBase: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="saludo">Hello!</string>
</resources>
`,
  stringsEs: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="saludo">Hola!</string>
</resources>
`,
  kotlinActivity: `package {{pkgname}}

import android.app.Activity
import android.os.Bundle

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
    }
}
`,
  gitignore: "build/\n",
};

// ---------------------------------------------------------------- apps de ejemplo
// Los cinco proyectos de banco/apps-ejemplo/*, copiados aquí para que se puedan crear desde el
// selector. No son variantes de la plantilla base: cada uno es una app completa, con su actividad,
// sus layouts (principal.xml e item.xml) y sus textos. El código generado tiene que ser ASCII puro
// (lo exige prueba.js), así que los comentarios van sin tilde, los separadores de las cadenas usan
// un guion y los acentos de res/values van en referencia numérica. Lo que la vista previa no
// modela (Bluetooth, SharedPreferences, Handler) se genera igual: es una app real, no un dibujo.
const APPS_EJEMPLO = {
  lienzo: {
    java: {
      "MainActivity.java": `package {{pkgname}};

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.view.View;

// La pantalla monta la vista propia en codigo, sin XML. Tocar la superficie avanza el fotograma:
// es la sonda de fidelidad del emulador (Canvas, Paint, invalidate y el ciclo de dibujo).
public class MainActivity extends Activity implements View.OnClickListener {
    private Lienzo lienzo;
    private int toques;

    @Override
    public void onCreate(Bundle estado) {
        super.onCreate(estado);
        Context contexto = this;
        lienzo = new Lienzo(contexto);
        lienzo.setOnClickListener(this);
        setContentView(lienzo);
    }

    @Override
    public void onClick(View vista) {
        toques = toques + 1;
        lienzo.setToques(toques);
        lienzo.avanzar();
    }
}
`,
      "Lienzo.java": `package {{pkgname}};

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

// Vista propia: todo el dibujo pasa por Canvas y Paint dentro de onDraw, sin recursos de imagen.
// Es la sonda de fidelidad del emulador: circulos, lineas y texto en coordenadas flotantes.
// Cada figura va en su propio metodo: el emisor reparte registros por metodo y una onDraw con
// demasiados locales a la vez se queda sin sitio para la forma corta de las instrucciones.
public class Lienzo extends View {
    private Paint pincel;
    private int fotograma;
    private int toques;
    private float campoX;
    private float campoY;
    private float pulso;

    public Lienzo(Context contexto) {
        super(contexto);
        pincel = new Paint();
        pincel.setAntiAlias(true);
        fotograma = 0;
        toques = 0;
    }

    public void setToques(int cuantos) {
        toques = cuantos;
    }

    public void avanzar() {
        fotograma = fotograma + 1;
        invalidate();
    }

    private void circulos(Canvas lienzo, float centroX, float centroY, float pulso) {
        pincel.setStyle(Paint.Style.STROKE);
        pincel.setStrokeWidth(4.0f);
        pincel.setColor(Color.rgb(70, 190, 255));
        for (int i = 0; i < 7; i++) {
            float radio = i * 22.0f;
            radio = radio + 30.0f;
            radio = radio + pulso;
            lienzo.drawCircle(centroX, centroY, radio, pincel);
        }
    }

    // Una linea por metodo: cada expresion deja su registro reservado para todo el metodo y seis
    // lineas en uno solo pasan de los quince que caben en la forma corta de aload/fload.
    private void rayo1(Canvas l, float cx, float cy) {
        l.drawLine(cx - 108.0f, cy - 180.0f, cx - 180.0f, cy + 180.0f, pincel);
    }

    private void rayo2(Canvas l, float cx, float cy) {
        l.drawLine(cx - 72.0f, cy - 180.0f, cx - 108.0f, cy + 180.0f, pincel);
    }

    private void rayo3(Canvas l, float cx, float cy) {
        l.drawLine(cx - 36.0f, cy - 180.0f, cx - 36.0f, cy + 180.0f, pincel);
    }

    private void rayo4(Canvas l, float cx, float cy) {
        l.drawLine(cx, cy - 180.0f, cx, cy + 180.0f, pincel);
    }

    private void rayo5(Canvas l, float cx, float cy) {
        l.drawLine(cx + 36.0f, cy - 180.0f, cx + 36.0f, cy + 180.0f, pincel);
    }

    private void rayo6(Canvas l, float cx, float cy) {
        l.drawLine(cx + 72.0f, cy - 180.0f, cx + 108.0f, cy + 180.0f, pincel);
    }

    private void rayos(Canvas l, float cx, float cy) {
        pincel.setColor(Color.rgb(255, 180, 60));
        pincel.setStrokeWidth(2.0f);
        rayo1(l, cx, cy);
        rayo2(l, cx, cy);
        rayo3(l, cx, cy);
        rayo4(l, cx, cy);
        rayo5(l, cx, cy);
        rayo6(l, cx, cy);
    }

    private void textos(Canvas lienzo) {
        pincel.setStyle(Paint.Style.FILL);
        pincel.setColor(Color.rgb(240, 240, 240));
        pincel.setTextSize(28.0f);
        lienzo.drawText("fotograma " + fotograma, 24.0f, 48.0f, pincel);
        lienzo.drawText("toques " + toques, 24.0f, 84.0f, pincel);
    }

    private void actualizarGeometria() {
        int ancho = getWidth();
        int alto = getHeight();
        campoX = ancho / 2.0f;
        campoY = alto / 2.0f;
        int resto = fotograma % 8;
        pulso = resto * 3.0f;
    }

    private void pintar(Canvas lienzo) {
        lienzo.drawColor(Color.rgb(18, 22, 30));
        circulos(lienzo, campoX, campoY, pulso);
        rayos(lienzo, campoX, campoY);
        pincel.setStyle(Paint.Style.FILL);
        pincel.setColor(Color.rgb(120, 240, 150));
        lienzo.drawCircle(campoX, campoY, 26.0f, pincel);
        textos(lienzo);
    }

    @Override
    protected void onDraw(Canvas lienzo) {
        super.onDraw(lienzo);
        actualizarGeometria();
        pintar(lienzo);
    }
}
`,
    },
    layouts: {},
    strings: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="siguiente">Siguiente fotograma</string>
    <string name="toques">Toques: </string>
</resources>
`,
  },
  notas: {
    java: {
      "MainActivity.java": `package {{pkgname}};

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;

// Bloc de notas: crear, editar y borrar con SharedPreferences. Las notas viven en un arreglo fijo y
// un contador, y se guardan en una clave por nota (nota0, nota1...) mas cuantas; al borrar se
// reescriben todas las claves para que no queden huecos.
// El adaptador se vuelve a construir con una copia del arreglo en cada cambio: es la forma que
// apkc preview pinta (el ArrayAdapter del framework solo ensena los elementos que recibe en su
// constructor) y en el aparato es lo mismo que hace notifyDataSetChanged, sin cache que invalidar.
// La seleccion se mueve con dos botones y no con clics en la lista, para que la secuencia de la
// sonda sea la misma en el emulador y en el aparato.
public class MainActivity extends Activity implements View.OnClickListener {
    private static final int MAXIMO = 64;

    private TextView editor;
    private TextView seleccion;
    private ListView lista;
    private ArrayAdapter adaptador;
    private SharedPreferences prefs;
    private String[] notas;
    private int cuantas;
    private int elegida;

    @Override
    public void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        editor = (TextView) findViewById(R.id.editor);
        seleccion = (TextView) findViewById(R.id.seleccion);
        lista = (ListView) findViewById(R.id.lista);
        prefs = getSharedPreferences("notas", 0);
        notas = new String[MAXIMO];
        cuantas = 0;
        elegida = -1;
        cargar();
        redibujar();
        findViewById(R.id.anterior).setOnClickListener(this);
        findViewById(R.id.siguiente).setOnClickListener(this);
        findViewById(R.id.nueva).setOnClickListener(this);
        findViewById(R.id.guardar).setOnClickListener(this);
        findViewById(R.id.borrar).setOnClickListener(this);
        pintarSeleccion();
    }

    private void cargar() {
        int guardadas = prefs.getInt("cuantas", 0);
        for (int i = 0; i < guardadas; i++) {
            if (cuantas >= MAXIMO) {
                return;
            }
            String clave = "nota" + i;
            String nota = prefs.getString(clave, "");
            notas[cuantas] = nota;
            cuantas = cuantas + 1;
        }
    }

    private void redibujar() {
        String[] copia = new String[cuantas];
        for (int i = 0; i < cuantas; i++) {
            copia[i] = notas[i];
        }
        adaptador = new ArrayAdapter(this, R.layout.item, copia);
        lista.setAdapter(adaptador);
    }

    private void persistir() {
        for (int i = 0; i < cuantas; i++) {
            String clave = "nota" + i;
            prefs.edit().putString(clave, notas[i]).apply();
        }
        prefs.edit().putInt("cuantas", cuantas).apply();
    }

    private void pintarSeleccion() {
        if (elegida < 0) {
            seleccion.setText("Nota nueva - hay " + cuantas);
            return;
        }
        String texto = "Nota " + (elegida + 1) + " de " + cuantas;
        seleccion.setText(texto);
    }

    private void mostrarElegida() {
        if (elegida < 0) {
            editor.setText("");
            return;
        }
        editor.setText(notas[elegida]);
    }

    private void mover(int paso) {
        if (cuantas == 0) {
            return;
        }
        int destino = elegida + paso;
        if (destino < 0) {
            destino = cuantas - 1;
        }
        if (destino >= cuantas) {
            destino = -1;
        }
        elegida = destino;
        mostrarElegida();
        pintarSeleccion();
    }

    private void nueva() {
        elegida = -1;
        editor.setText("");
        pintarSeleccion();
    }

    // getEditableText() y no getText(): el segundo tiene dos sobrecargas en EditText y el
    // emisor no elige la mas especifica de este subconjunto (limitacion medida).
    private void guardar() {
        String texto = editor.getEditableText().toString();
        if (texto.length() == 0) {
            return;
        }
        if (elegida < 0) {
            if (cuantas >= MAXIMO) {
                return;
            }
            notas[cuantas] = texto;
            cuantas = cuantas + 1;
            elegida = cuantas - 1;
        } else {
            notas[elegida] = texto;
        }
        persistir();
        redibujar();
        pintarSeleccion();
    }

    // El indice a borrar se calcula en un metodo propio: reasignar una local dentro de un if y
    // leerla despues deja el hueco sin asignar en el marco que valida nuestro emisor (medido al
    // compilar esta plantilla con apkc build --linker go --compiler go).
    private int indiceBorrar() {
        if (elegida >= 0) {
            return elegida;
        }
        return cuantas - 1;
    }

    private void borrar() {
        if (cuantas == 0) {
            return;
        }
        int cual = indiceBorrar();
        for (int i = cual; i < cuantas - 1; i++) {
            notas[i] = notas[i + 1];
        }
        cuantas = cuantas - 1;
        notas[cuantas] = null;
        persistir();
        // la clave que quedo detras del contador se borra: no basta con no leerla, porque un
        // cuantas restaurado desde otra sesion la resucitaria
        String sobrante = "nota" + cuantas;
        prefs.edit().remove(sobrante).apply();
        redibujar();
        elegida = cual;
        if (elegida >= cuantas) {
            elegida = cuantas - 1;
        }
        mostrarElegida();
        pintarSeleccion();
    }

    @Override
    public void onClick(View vista) {
        // Se compara getId() directamente y cada rama termina con return: guardar el id en una
        // local y encadenar tres else if deja el hueco sin asignar en el marco del emisor.
        if (vista.getId() == R.id.anterior) {
            mover(-1);
            return;
        }
        if (vista.getId() == R.id.siguiente) {
            mover(1);
            return;
        }
        if (vista.getId() == R.id.nueva) {
            nueva();
            return;
        }
        if (vista.getId() == R.id.guardar) {
            guardar();
            return;
        }
        borrar();
    }
}
`,
    },
    layouts: {
      "principal.xml": `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <TextView
        android:id="@+id/titulo"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/titulo" />

    <TextView
        android:id="@+id/seleccion"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/inicial" />

    <EditText
        android:id="@+id/editor"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:hint="@string/pista" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal">

        <Button
            android:id="@+id/anterior"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/anterior" />

        <Button
            android:id="@+id/siguiente"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/siguiente" />

        <Button
            android:id="@+id/nueva"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/nueva" />

        <Button
            android:id="@+id/guardar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/guardar" />

        <Button
            android:id="@+id/borrar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/borrar" />
    </LinearLayout>

    <ListView
        android:id="@+id/lista"
        android:layout_width="match_parent"
        android:layout_height="wrap_content" />
</LinearLayout>
`,
      "item.xml": `<?xml version="1.0" encoding="utf-8"?>
<TextView xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
`,
    },
    strings: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="titulo">Bloc de notas</string>
    <string name="pista">Escribe una nota</string>
    <string name="nueva">Nueva</string>
    <string name="inicial">Nota nueva</string>
    <string name="anterior">Anterior</string>
    <string name="siguiente">Siguiente</string>
    <string name="guardar">Guardar</string>
    <string name="borrar">Borrar</string>
</resources>
`,
  },
  chatbt: {
    java: {
      "MainActivity.java": `package {{pkgname}};

import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;

import java.util.Iterator;
import java.util.Set;

// Chat Bluetooth: la lista de mensajes, el envio local y el estado del adaptador. La conexion real
// por BluetoothSocket queda como frontera: aqui no se abre ningun socket ni se toca la red; el
// mensaje entra en la lista y un eco local confirma el recorrido del texto.
// En Android 12+ el listado y el descubrimiento necesitan BLUETOOTH_CONNECT/SCAN en tiempo de
// ejecucion, asi que la app los pide al arrancar y, si no estan, lo dice en vez de caerse.
// El adaptador de la lista se reconstruye con una copia del arreglo en cada cambio: es la forma que
// apkc preview pinta y en el aparato equivale a notifyDataSetChanged sin cache que invalidar.
public class MainActivity extends Activity implements View.OnClickListener {
    private static final int MAXIMO = 128;
    private static final int SIN_ADAPTADOR = 0;
    private static final int APAGADO = 1;
    private static final int LISTO = 2;

    private TextView estado;
    private TextView entrada;
    private ListView lista;
    private ArrayAdapter adaptador;
    private BluetoothAdapter adaptadorBt;
    private String[] mensajes;
    private int cuantos;
    private int marcha;
    private int vinculos;

    @Override
    public void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        estado = (TextView) findViewById(R.id.estado);
        entrada = (TextView) findViewById(R.id.entrada);
        lista = (ListView) findViewById(R.id.mensajes);
        mensajes = new String[MAXIMO];
        cuantos = 0;
        marcha = SIN_ADAPTADOR;
        vinculos = 0;
        redibujar();
        findViewById(R.id.enviar).setOnClickListener(this);
        findViewById(R.id.buscar).setOnClickListener(this);
        findViewById(R.id.limpiar).setOnClickListener(this);
        pedirPermisos();
    }

    private void redibujar() {
        String[] copia = new String[cuantos];
        for (int i = 0; i < cuantos; i++) {
            copia[i] = mensajes[i];
        }
        adaptador = new ArrayAdapter(this, R.layout.item, copia);
        lista.setAdapter(adaptador);
        pintarEstado();
    }

    // El estado del adaptador es texto y no solo un color: es lo que comparan los oraculos del
    // emulador y del aparato, que no ven nada mas de una conexion que no se abre.
    private void pintarEstado() {
        String texto = "Bluetooth listo";
        if (marcha == SIN_ADAPTADOR) {
            texto = "Este aparato no tiene Bluetooth";
        } else if (marcha == APAGADO) {
            texto = "Bluetooth apagado";
        }
        estado.setText(texto + " - " + vinculos + " vinculos - " + cuantos + " mensajes");
    }

    private void pedirPermisos() {
        // Los permisos se preparan antes del if: un local declarado despues de un return dentro del
        // if se lee como "sin asignar en algun camino" en el verificador del emisor (aload_2).
        String[] cuales = new String[] { "android.permission.BLUETOOTH_CONNECT", "android.permission.BLUETOOTH_SCAN" };
        int permiso = checkSelfPermission("android.permission.BLUETOOTH_CONNECT");
        if (permiso == PackageManager.PERMISSION_GRANTED) {
            preparar();
            return;
        }
        requestPermissions(cuales, 7);
    }

    @Override
    public void onRequestPermissionsResult(int codigo, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(codigo, permisos, resultados);
        if (resultados.length > 0) {
            if (resultados[0] == PackageManager.PERMISSION_GRANTED) {
                preparar();
                return;
            }
        }
        pintarEstado();
    }

    private void preparar() {
        adaptadorBt = BluetoothAdapter.getDefaultAdapter();
        if (adaptadorBt == null) {
            marcha = SIN_ADAPTADOR;
            pintarEstado();
            return;
        }
        boolean encendido = adaptadorBt.isEnabled();
        if (encendido == false) {
            marcha = APAGADO;
            pintarEstado();
            return;
        }
        marcha = LISTO;
        vinculos = 0;
        Set enlazados = adaptadorBt.getBondedDevices();
        if (enlazados != null) {
            vinculos = enlazados.size();
        }
        pintarEstado();
    }

    // Un vinculo por linea, con nombre y direccion; el nombre puede faltar y entonces se dice.
    private void listarVinculos() {
        if (marcha != LISTO) {
            preparar();
            return;
        }
        Set enlazados = adaptadorBt.getBondedDevices();
        if (enlazados == null) {
            pintarEstado();
            return;
        }
        Iterator it = enlazados.iterator();
        boolean hay = it.hasNext();
        while (hay == true) {
            BluetoothDevice equipo = (BluetoothDevice) it.next();
            String nombre = equipo.getName();
            String linea = nombre + " " + equipo.getAddress();
            anotar(linea);
            hay = it.hasNext();
        }
        pintarEstado();
    }

    // El descubrimiento se lanza, pero sus resultados no se recogen: registrar un
    // BroadcastReceiver exigiria una clase anonima que extiende una clase (no medida) o asignar una
    // subclase a un campo del supertipo (el emisor lo rechaza por nombre). Frontera documentada.
    private void descubrir() {
        if (marcha != LISTO) {
            return;
        }
        adaptadorBt.startDiscovery();
        estado.setText(R.string.buscando);
    }

    private void anotar(String linea) {
        if (cuantos >= MAXIMO) {
            return;
        }
        mensajes[cuantos] = linea;
        cuantos = cuantos + 1;
    }

    // La concatenacion se hace en un local y no en el argumento: el emisor no estima el tipo de una
    // expresion usada como argumento sin emitirla antes (limitacion medida con Evento.getX()).
    private void anotarDe(String prefijo, String texto) {
        String linea = prefijo + texto;
        anotar(linea);
    }

    // Envio local: el texto entra como yo y el eco prueba que el mensaje paso por la lista. No hay
    // socket, asi que el eco lo escribe la propia app y se dice en la linea.
    private void enviar() {
        String texto = entrada.getEditableText().toString();
        if (texto.length() == 0) {
            return;
        }
        anotarDe("yo: ", texto);
        String eco = texto + " (sin socket)";
        anotarDe("eco: ", eco);
        entrada.setText("");
        redibujar();
    }

    private void limpiar() {
        cuantos = 0;
        redibujar();
    }

    @Override
    public void onClick(View vista) {
        int cual = vista.getId();
        if (cual == R.id.enviar) {
            enviar();
        } else if (cual == R.id.limpiar) {
            limpiar();
        } else {
            listarVinculos();
            descubrir();
        }
    }
}
`,
    },
    layouts: {
      "principal.xml": `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <TextView
        android:id="@+id/estado"
        android:layout_width="match_parent"
        android:layout_height="wrap_content" />

    <EditText
        android:id="@+id/entrada"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:hint="@string/pista" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal">

        <Button
            android:id="@+id/enviar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/enviar" />

        <Button
            android:id="@+id/buscar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/buscar" />

        <Button
            android:id="@+id/limpiar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/limpiar" />
    </LinearLayout>

    <ListView
        android:id="@+id/mensajes"
        android:layout_width="match_parent"
        android:layout_height="wrap_content" />
</LinearLayout>
`,
      "item.xml": `<?xml version="1.0" encoding="utf-8"?>
<TextView xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
`,
    },
    strings: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="pista">Mensaje para el equipo</string>
    <string name="enviar">Enviar</string>
    <string name="buscar">Buscar equipos</string>
    <string name="limpiar">Limpiar</string>
    <string name="sin_bt">Este aparato no tiene Bluetooth &#183; 0 mensajes</string>
    <string name="apagado">Bluetooth apagado &#183; 0 mensajes</string>
    <string name="listo">Bluetooth listo &#183; 0 v&#237;nculos &#183; 0 mensajes</string>
    <string name="buscando">Buscando equipos &#183; 0 mensajes</string>
    <string name="sin_permiso">Falta el permiso de Bluetooth &#183; 0 mensajes</string>
</resources>
`,
    permisos: `    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
`,
  },
  tareas: {
    java: {
      "MainActivity.java": `package {{pkgname}};

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;

// Lista de tareas con categoria, estado y filtro. Tres arreglos paralelos (texto, categoria y hecha)
// mas un contador, persistidos en SharedPreferences con una clave por campo y tarea.
// El adaptador se reconstruye con la copia ya filtrada cada vez que algo cambia: es la forma que
// apkc preview pinta (el ArrayAdapter del framework ensena los elementos que recibe en el
// constructor) y en el aparato equivale a notifyDataSetChanged sin cache que invalidar.
public class MainActivity extends Activity implements View.OnClickListener {
    private static final int MAXIMO = 64;

    private TextView nueva;
    private TextView etiqueta;
    private ListView lista;
    private ArrayAdapter adaptador;
    private SharedPreferences prefs;
    private String[] textos;
    private String[] categorias;
    private String[] hechas;
    private int cuantas;
    private int filtro;

    @Override
    public void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        nueva = (TextView) findViewById(R.id.nueva);
        etiqueta = (TextView) findViewById(R.id.categoria);
        lista = (ListView) findViewById(R.id.lista);
        prefs = getSharedPreferences("tareas", 0);
        textos = new String[MAXIMO];
        categorias = new String[MAXIMO];
        hechas = new String[MAXIMO];
        cuantas = 0;
        filtro = 0;
        cargar();
        findViewById(R.id.casa).setOnClickListener(this);
        findViewById(R.id.trabajo).setOnClickListener(this);
        findViewById(R.id.estudio).setOnClickListener(this);
        findViewById(R.id.agregar).setOnClickListener(this);
        findViewById(R.id.completar).setOnClickListener(this);
        findViewById(R.id.filtrar).setOnClickListener(this);
        redibujar();
    }

    private void cargar() {
        int guardadas = prefs.getInt("cuantas", 0);
        String clave;
        for (int i = 0; i < guardadas; i++) {
            if (cuantas >= MAXIMO) {
                return;
            }
            clave = "texto" + i;
            textos[cuantas] = prefs.getString(clave, "");
            clave = "categoria" + i;
            categorias[cuantas] = prefs.getString(clave, "Casa");
            clave = "hecha" + i;
            hechas[cuantas] = prefs.getString(clave, "no");
            cuantas = cuantas + 1;
        }
    }

    private void guardar(int indice) {
        String clave = "texto" + indice;
        prefs.edit().putString(clave, textos[indice]).apply();
        clave = "categoria" + indice;
        prefs.edit().putString(clave, categorias[indice]).apply();
        clave = "hecha" + indice;
        prefs.edit().putString(clave, hechas[indice]).apply();
        prefs.edit().putInt("cuantas", cuantas).apply();
    }

    private String nombreFiltro() {
        if (filtro == 1) {
            return "Casa";
        }
        if (filtro == 2) {
            return "Trabajo";
        }
        if (filtro == 3) {
            return "Estudio";
        }
        return "Todas";
    }

    private boolean visible(int i) {
        if (filtro == 0) {
            return true;
        }
        return categorias[i].equals(nombreFiltro());
    }

    private String componer(int i) {
        String marca = "[ ] ";
        boolean lista = hechas[i].equals("si");
        if (lista == true) {
            marca = "[x] ";
        }
        return marca + textos[i] + " (" + categorias[i] + ")";
    }

    private int contarVisibles() {
        int total = 0;
        boolean dentro;
        for (int i = 0; i < cuantas; i++) {
            dentro = visible(i);
            if (dentro == true) {
                total = total + 1;
            }
        }
        return total;
    }

    private int contarPendientes() {
        int total = 0;
        boolean dentro;
        boolean pendiente;
        for (int i = 0; i < cuantas; i++) {
            dentro = visible(i);
            if (dentro == true) {
                pendiente = hechas[i].equals("no");
                if (pendiente == true) {
                    total = total + 1;
                }
            }
        }
        return total;
    }

    private String[] copiaVisible() {
        int n = contarVisibles();
        String[] copia = new String[n];
        int siguiente = 0;
        boolean dentro;
        for (int i = 0; i < cuantas; i++) {
            dentro = visible(i);
            if (dentro == true) {
                copia[siguiente] = componer(i);
                siguiente = siguiente + 1;
            }
        }
        return copia;
    }

    private void pintarLista() {
        String[] copia = copiaVisible();
        adaptador = new ArrayAdapter(this, R.layout.item, copia);
        lista.setAdapter(adaptador);
    }

    private void redibujar() {
        pintarLista();
        int visibles = contarVisibles();
        int pendientes = contarPendientes();
        String texto = "Filtro: " + nombreFiltro() + " - " + visibles + " - pendientes " + pendientes;
        etiqueta.setText(texto);
    }

    // El texto de la tarea nueva y su categoria salen de dos campos: el de al lado del teclado y el
    // que se elige con los tres botones. Al agregar se queda seleccionada la misma categoria.
    private void agregar() {
        String texto = nueva.getEditableText().toString();
        if (texto.length() == 0) {
            return;
        }
        if (cuantas >= MAXIMO) {
            return;
        }
        textos[cuantas] = texto;
        categorias[cuantas] = nombreFiltro();
        boolean sinFiltro = categorias[cuantas].equals("Todas");
        if (sinFiltro == true) {
            categorias[cuantas] = "Casa";
        }
        hechas[cuantas] = "no";
        guardar(cuantas);
        cuantas = cuantas + 1;
        prefs.edit().putInt("cuantas", cuantas).apply();
        nueva.setText("");
        redibujar();
    }

    // Marca la primera pendiente que el filtro deja ver, y no la primera de la lista completa: con
    // el filtro en Trabajo, completar la primera de Casa seria un efecto invisible.
    private void completar() {
        boolean pendiente;
        for (int i = 0; i < cuantas; i++) {
            pendiente = visible(i);
            if (pendiente == true) {
                pendiente = hechas[i].equals("no");
            }
            if (pendiente == true) {
                hechas[i] = "si";
                guardar(i);
                redibujar();
                return;
            }
        }
    }

    private void elegirCategoria(int cual) {
        filtro = cual;
        redibujar();
    }

    @Override
    public void onClick(View vista) {
        int cual = vista.getId();
        if (cual == R.id.casa) {
            elegirCategoria(1);
        } else if (cual == R.id.trabajo) {
            elegirCategoria(2);
        } else if (cual == R.id.estudio) {
            elegirCategoria(3);
        } else if (cual == R.id.agregar) {
            agregar();
        } else if (cual == R.id.completar) {
            completar();
        } else {
            int siguiente = filtro + 1;
            if (siguiente > 3) {
                siguiente = 0;
            }
            elegirCategoria(siguiente);
        }
    }
}
`,
    },
    layouts: {
      "principal.xml": `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <TextView
        android:id="@+id/titulo"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/titulo" />

    <TextView
        android:id="@+id/categoria"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/categoria" />

    <EditText
        android:id="@+id/nueva"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:hint="@string/pista" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal">

        <Button
            android:id="@+id/casa"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/casa" />

        <Button
            android:id="@+id/trabajo"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/trabajo" />

        <Button
            android:id="@+id/estudio"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/estudio" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal">

        <Button
            android:id="@+id/agregar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/agregar" />

        <Button
            android:id="@+id/completar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/completar" />

        <Button
            android:id="@+id/filtrar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/filtrar" />
    </LinearLayout>

    <ListView
        android:id="@+id/lista"
        android:layout_width="match_parent"
        android:layout_height="wrap_content" />
</LinearLayout>
`,
      "item.xml": `<?xml version="1.0" encoding="utf-8"?>
<TextView xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
`,
    },
    strings: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="titulo">Lista de tareas</string>
    <string name="pista">Nueva tarea</string>
    <string name="casa">Casa</string>
    <string name="trabajo">Trabajo</string>
    <string name="estudio">Estudio</string>
    <string name="agregar">Agregar</string>
    <string name="completar">Completar la primera</string>
    <string name="filtrar">Filtrar</string>
    <string name="categoria">Categor&#237;a: </string>
</resources>
`,
  },
  cronometro: {
    java: {
      "MainActivity.java": `package {{pkgname}};

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.ListView;
import android.widget.TextView;

// Cronometro con Handler.postDelayed: la propia actividad es el Runnable que se reprograma cada
// 50 ms mientras corre. El tiempo sale de SystemClock.elapsedRealtime() (monotonico, no de pared),
// asi que pausar y reanudar suma sin deriva; el tick solo repinta.
// Ademas del tiempo se cuentan los pulsos: es lo unico que apkc preview puede ver del reloj, que
// no finge (no hay SystemClock en sus stubs), y en el aparato sirve para comparar el tick real con
// el logico de la sonda.
// Las cuentas de tiempo van partidas en metodos pequenos porque cada expresion deja su registro
// reservado para todo el metodo en el emisor Go.
public class MainActivity extends Activity implements View.OnClickListener, Runnable {
    private static final int MAXIMO = 64;

    private TextView tiempo;
    private TextView estado;
    private ListView lista;
    private ArrayAdapter adaptador;
    private Handler manejador;
    private String[] marcas;
    private int cuantas;
    private long inicio;
    private long acumulado;
    private int corriendo;
    private int pulsos;

    @Override
    public void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        setContentView(R.layout.principal);
        tiempo = (TextView) findViewById(R.id.tiempo);
        estado = (TextView) findViewById(R.id.estado);
        lista = (ListView) findViewById(R.id.vueltas);
        manejador = new Handler();
        marcas = new String[MAXIMO];
        cuantas = 0;
        inicio = 0L;
        acumulado = 0L;
        corriendo = 0;
        pulsos = 0;
        findViewById(R.id.iniciar).setOnClickListener(this);
        findViewById(R.id.pausar).setOnClickListener(this);
        findViewById(R.id.vuelta).setOnClickListener(this);
        findViewById(R.id.reiniciar).setOnClickListener(this);
        pintar();
    }

    private long actual() {
        if (corriendo == 0) {
            return acumulado;
        }
        long ahora = SystemClock.elapsedRealtime();
        long transcurrido = ahora - inicio;
        return acumulado + transcurrido;
    }

    private String dosDigitos(long valor) {
        // (int) y concatenacion, no Long.toString(long): ese stub no existe en el interprete de
        // apkc preview (devolvia null y la pantalla ensenaba 0null) y la concatenacion con un
        // long directo la rechaza el emisor (88: solo append de entero, cadena y referencia).
        int cifras = (int) valor;
        if (cifras < 10) {
            return "0" + cifras;
        }
        return "" + cifras;
    }

    private String minutos(long total) {
        long valor = total / 60000L;
        return dosDigitos(valor);
    }

    private String segundos(long total) {
        long valor = total % 60000L;
        valor = valor / 1000L;
        return dosDigitos(valor);
    }

    private String centesimas(long total) {
        long valor = total % 60000L;
        valor = valor % 1000L;
        valor = valor / 10L;
        return dosDigitos(valor);
    }

    private String formato(long total) {
        String parteMinutos = minutos(total);
        String parteSegundos = segundos(total);
        String parteCentesimas = centesimas(total);
        return parteMinutos + ":" + parteSegundos + "." + parteCentesimas;
    }

    private void pintar() {
        long total = actual();
        tiempo.setText(formato(total));
        String marcha = "parado";
        if (corriendo == 1) {
            marcha = "corriendo";
        }
        estado.setText(marcha + " - pulsos " + pulsos);
    }

    private void iniciar() {
        if (corriendo == 1) {
            return;
        }
        inicio = SystemClock.elapsedRealtime();
        corriendo = 1;
        manejador.postDelayed(this, 0L);
        pintar();
    }

    private void pausar() {
        if (corriendo == 0) {
            return;
        }
        acumulado = actual();
        corriendo = 0;
        manejador.removeCallbacks(this);
        pintar();
    }

    private void redibujar() {
        String[] copia = new String[cuantas];
        for (int i = 0; i < cuantas; i++) {
            copia[i] = marcas[i];
        }
        adaptador = new ArrayAdapter(this, R.layout.item, copia);
        lista.setAdapter(adaptador);
    }

    // La marca se toma aunque el reloj logico del emulador valga cero (no finge la hora): mientras
    // el tick haya corrido, el pulso es una marca valida y comparable entre los dos lados.
    private void marcarVuelta() {
        long total = actual();
        if (total == 0L) {
            if (pulsos == 0) {
                return;
            }
        }
        if (cuantas >= MAXIMO) {
            return;
        }
        marcas[cuantas] = formato(total) + " - pulso " + pulsos;
        cuantas = cuantas + 1;
        redibujar();
    }

    private void reiniciar() {
        manejador.removeCallbacks(this);
        corriendo = 0;
        acumulado = 0L;
        inicio = SystemClock.elapsedRealtime();
        pulsos = 0;
        cuantas = 0;
        redibujar();
        pintar();
    }

    @Override
    public void run() {
        if (corriendo == 1) {
            pulsos = pulsos + 1;
            pintar();
            manejador.postDelayed(this, 50L);
        }
    }

    @Override
    public void onClick(View vista) {
        int cual = vista.getId();
        if (cual == R.id.iniciar) {
            iniciar();
        } else if (cual == R.id.pausar) {
            pausar();
        } else if (cual == R.id.vuelta) {
            marcarVuelta();
        } else {
            reiniciar();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        manejador.removeCallbacks(this);
    }
}
`,
    },
    layouts: {
      "principal.xml": `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical">

    <TextView
        android:id="@+id/tiempo"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/cero" />

    <TextView
        android:id="@+id/estado"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:text="@string/parado" />

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal">

        <Button
            android:id="@+id/iniciar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/iniciar" />

        <Button
            android:id="@+id/pausar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/pausar" />

        <Button
            android:id="@+id/vuelta"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/vuelta" />

        <Button
            android:id="@+id/reiniciar"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="@string/reiniciar" />
    </LinearLayout>

    <ListView
        android:id="@+id/vueltas"
        android:layout_width="match_parent"
        android:layout_height="wrap_content" />
</LinearLayout>
`,
      "item.xml": `<?xml version="1.0" encoding="utf-8"?>
<TextView xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="wrap_content" />
`,
    },
    strings: `<resources>
    <string name="app_name">{{appname}}</string>
    <string name="cero">00:00.00</string>
    <string name="parado">parado &#183; pulsos 0</string>
    <string name="iniciar">Iniciar</string>
    <string name="pausar">Pausar</string>
    <string name="vuelta">Vuelta</string>
    <string name="reiniciar">Reiniciar</string>
</resources>
`,
  },
};

// ---------------------------------------------------------------- el proyecto
function buildProject(state) {
  const pkg = state.package;
  const dirs = ["src", "lib/arm64-v8a", "lib/armeabi-v7a", "lib/x86", "lib/x86_64",
                "res/layout", "res/values"];
  dirs.push(...pkg.split(".").map((_, i, all) => "src/" + all.slice(0, i + 1).join("/")));
  if (state.kotlin) dirs.push("src/" + pkg.split(".").join("/"));
  if (state.libs) dirs.push("jar");
  if (state.assets) dirs.push("assets");

  // el bloque del botón va antes del último } del fichero, que es el de la clase: anclado al
  // primero se colaba dentro de onCreate y javac paraba el proyecto entero
  const texto = (v, def) => (v === undefined || v === null || String(v).trim() === "" ? def : String(v));
  const boton = { label: texto(state.buttonLabel, "Press me"), toast: texto(state.toast, "Clicked!") };
  const extra = state.button
    ? TEMPLATES.activityButton
        .replace(/\{\{hello\}\}/g, texto(state.hello, "Hello World!"))
        .replace(/\{\{toast\}\}/g, boton.toast)
    : "";
  const activityBody = TEMPLATES.activity.replace(/\{\{pkgname\}\}/g, pkg)
    .replace(/\}\n$/, extra + "}\n");

  const files = {
    "AndroidManifest.xml": TEMPLATES.manifest
      .replace(/\{\{pkgname\}\}/g, pkg)
      .replace(/\{\{appname\}\}/g, state.name)
      .replace(/\{\{minsdk\}\}/g, state.minsdk)
      .replace(/\{\{targetsdk\}\}/g, state.targetsdk)
      .replace(/\{\{extras\}\}/g, state.native ? '\n        android:extractNativeLibs="false"' : "")
      .replace(/\{\{activity\}\}/g, `        <activity
            android:theme="@style/AppTheme"
            android:name=".MainActivity"
            android:label="${state.name}"
            android:exported="true" >

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>

        </activity>
`),
    "res/layout/main.xml": TEMPLATES.layout
      .replace(/\{\{hello\}\}/g, texto(state.hello, "Hello World!"))
      .replace(/\{\{button\}\}/g, state.button
        ? TEMPLATES.layoutButton.replace(/\{\{button\}\}/g, boton.label) : ""),
    "res/values/styles.xml": TEMPLATES.styles,
    ".gitignore": TEMPLATES.gitignore,
  };
  if (state.kotlin) {
    files["src/" + pkg.split(".").join("/") + "/MainActivity.kt"] =
      TEMPLATES.kotlinActivity.replace(/\{\{pkgname\}\}/g, pkg);
  } else {
    files["src/" + pkg.split(".").join("/") + "/MainActivity.java"] = activityBody;
  }
  // la plantilla Contador sustituye el layout y la actividad; el manifiesto y los recursos son
  // los mismos, y el botón no necesita el bloque de menú de `activityButton`
  if (state.template === "contador" && !state.kotlin) {
    files["res/layout/main.xml"] = TEMPLATES.layoutContador;
    files["src/" + pkg.split(".").join("/") + "/MainActivity.java"] =
      TEMPLATES.activityContador.replace(/\{\{pkgname\}\}/g, pkg);
  }
  // Las tres plantillas nuevas son variantes del mismo esqueleto: cambian la actividad, el
  // layout o los valores, pero ninguna introduce una forma de Java que el emisor no mida.
  if (!state.kotlin && state.template === "ciclo") {
    files["src/" + pkg.split(".").join("/") + "/MainActivity.java"] =
      TEMPLATES.activityCiclo.replace(/\{\{pkgname\}\}/g, pkg);
  }
  if (!state.kotlin && state.template === "menu") {
    files["src/" + pkg.split(".").join("/") + "/MainActivity.java"] =
      TEMPLATES.activityMenu.replace(/\{\{pkgname\}\}/g, pkg);
  }
  if (!state.kotlin && state.template === "traducido") {
    dirs.push("res/values-es");
    files["res/layout/main.xml"] = TEMPLATES.layoutTraducido;
    const nombre = texto(state.name, "Mi app");
    files["res/values/strings.xml"] = TEMPLATES.stringsBase.replace(/\{\{appname\}\}/g, nombre);
    files["res/values-es/strings.xml"] = TEMPLATES.stringsEs.replace(/\{\{appname\}\}/g, nombre);
    files["AndroidManifest.xml"] = files["AndroidManifest.xml"]
      .replace(/android:label="[^"]*"/g, 'android:label="@string/app_name"');
  }
  // Las cinco apps de ejemplo del banco se generan enteras: sustituyen la actividad, los layouts y
  // los textos, y el manifiesto pasa a etiquetar desde @string/app_name como las originales. El
  // layout main.xml de la plantilla base se retira porque estas apps usan principal.xml o ninguno.
  const app = !state.kotlin ? APPS_EJEMPLO[state.template] : null;
  if (app) {
    delete files["res/layout/main.xml"];
    const rutaFuentes = "src/" + pkg.split(".").join("/");
    for (const [nombre, contenido] of Object.entries(app.java)) {
      files[rutaFuentes + "/" + nombre] = contenido.replace(/\{\{pkgname\}\}/g, pkg);
    }
    for (const [nombre, contenido] of Object.entries(app.layouts)) {
      files["res/layout/" + nombre] = contenido;
    }
    files["res/values/strings.xml"] = app.strings.replace(/\{\{appname\}\}/g, texto(state.name, "Mi app"));
    files["AndroidManifest.xml"] = files["AndroidManifest.xml"]
      .replace(/android:label="[^"]*"/g, 'android:label="@string/app_name"');
    if (app.permisos) {
      // el bloque <uses-sdk .../> de la plantilla base es autocerrado: los permisos entran detrás
      files["AndroidManifest.xml"] = files["AndroidManifest.xml"]
        .replace(/(<uses-sdk[^>]*\/>)/, (bloque) => bloque + "\n" + app.permisos);
    }
  }
  // un LEEME dentro de jar/, assets/ o lib/<abi>/ no es inocente: apkc mete lo que hay en
  // assets/ y en lib/ en el apk, y un .txt en lib/arm64-v8a/ viaja como si fuera una .so. La
  // explicación va en la raíz, que es el único sitio que apkc ignora.
  const notas = [];
  if (state.libs) notas.push("jar/       los .jar de dependencias; apkc los dexa y los mete en el apk sin\n"
    + "           que nadie los declare. un .aar no lo lee: saca antes su classes.jar y ponlo aquí.");
  if (state.assets) notas.push("assets/    lo que haya dentro llega al apk tal cual; borrarlo o renombrarlo\n"
    + "           también lo quita del paquete.");
  if (state.native) notas.push("lib/<abi>/  con extractNativeLibs=\"false\" en el manifest, el .so viaja sin comprimir\n"
    + "           y alineado a página; con \"true\" (o sin atributo) el sistema lo descomprime al instalar.");
  if (notas.length) files["LEEME.txt"] = notas.join("\n\n") + "\n";
  return { dirs, files };
}

// ---------------------------------------------------------------- zip (STORE, sin dependencias)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Solo entradas guardadas (STORE): lo que se guarda es texto pequeño, y así el lector del
// zip no necesita nada para abrirlo. El campo de descriptor de datos se deja sin poner a
// propósito, que es justo el error que zipcheck.py caza en un apk.
// Acepta texto o bytes: exportar el proyecto tiene que copiar un PNG o un .apk sin tocarlo.
function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const [name, contenido] of entries) {
    const nameBytes = enc.encode(name);
    const data = contenido instanceof Uint8Array ? contenido : enc.encode(contenido);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // versión needed
    local.setUint16(6, 0x0800, true);      // flags: nombres en UTF-8, sin descriptor
    local.setUint16(8, 0, true);           // metodo: stored
    local.setUint16(10, 0, true);          // hora
    local.setUint16(12, 0x21, true);       // fecha: 1980-01-01, dosTime minimo legal
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 0x031e, true);         // hecho por UNIX, zip 3.0
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, 0, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    // atributos externos: el modo UNIX va en los 16 bits altos, y sin ellos quien
    // descomprime crea los directorios en 000 y el proyecto queda ilegible
    const esDir = name.endsWith("/");
    cd.setUint32(38, (esDir ? 0o40755 : 0o100644) * 0x10000 + (esDir ? 0x10 : 0), true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const cdStart = offset;
  for (const c of central) { parts.push(c); offset += c.length; }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  // el número de entradas, no el de trozos escritos: cada entrada son dos partes (record +
  // nombre) y un lector estricto busca después de la última otra firma y se encuentra el EOCD
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, offset - cdStart, true);
  end.setUint32(16, cdStart, true);
  parts.push(new Uint8Array(end.buffer));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------------------------------------------------------------- analizador de salida
// Cada regla lleva lit:, la cadena textual que la motivó, y de:, de quien sale esa cadena.
// prueba.js exige que las de `de: "apkc"` existan literalmente en el repo: una regla inventada
// no falla ruidosamente, es peor que no tenerla, porque la página explica un error que nadie
// imprime. Las de otra herramienta cuentan con la salida capturada en muestras.json, y si no
// la hay, la prueba lo dice en vez de callarlo. El id va en ascii porque acaba en los
// contadores del informe.
const RULES = [
  { id: "proyecto-incompleto", re: /stat (src|res|jar|assets|lib)(\/[^:]*)?: no such file or directory|there is no `[^`]+`(, `[^`]+`)* and `[^`]+` here|there is no `[^`]+` here, so this is not an apkc project/,
    de: "apkc", lit: "so this is not an apkc project",
    capa: "proyecto", que: "no hay un proyecto apkc en el directorio donde se ejecutó el comando",
    hacer: "entra en la carpeta del proyecto, o arranca uno con `apkc create .` (o `apkc create <carpeta>`). apkc no busca hacia arriba: trabaja donde está el cwd. Las versiones viejas decían solo `stat src: no such file or directory`. " },
  { id: "sdk-java-home", re: /(ANDROID_HOME|JAVA_HOME) was not found|SDK path unknown/,
    de: "apkc", lit: "SDK path unknown",
    capa: "entorno", que: "apkc no encuentra el SDK de Android o el JDK",
    hacer: "exporta ANDROID_HOME (o JAVA_HOME) en el shell que ejecuta el comando; en Termux el SDK suele estar en ~/Android y el JDK en $PREFIX/lib/jvm. Comprueba con `apkc doctor`, que imprime la ruta que resolvió." },
  { id: "build-tools-parse", re: /error parsing build tools version/,
    de: "apkc", lit: "error parsing build tools version",
    capa: "entorno", que: "una carpeta bajo build-tools no se parece a una versión",
    hacer: "esa carpeta no es del SDK: muévela fuera de build-tools/." },
  { id: "keystore-missing", re: /no debug keystore at/,
    de: "apkc", lit: "no debug keystore at",
    capa: "entorno", que: "no existe el keystore de depuración, y sin él no hay apk firmado",
    hacer: "deja que el SDK lo cree instalando cualquier cosa, o genéralo: keytool -genkeypair -keystore ~/.android/debug.keystore -storepass android -keypass android -alias androiddebugkey -keyalg RSA -dname 'CN=Android Debug,O=Android,C=US'." },
  { id: "herramienta-no-arranca", re: /never started: /,
    de: "apkc", lit: "never started",
    capa: "entorno", que: "la herramienta del SDK no llegó a ejecutarse (no es que fallara ejecutándose)",
    hacer: "es un problema de arranque, no de tu código: el archivo no existe, no tiene permiso de ejecución, o el binario es de otra arquitectura. `apkc doctor` imprime la ruta que resolvió para cada herramienta. En un build js/wasm el motivo es que el navegador no puede hablar con un proceso: ahí ni aapt2 ni javac ni d8 existen." },
  { id: "keystore-file-missing", re: /there is no keystore at|Failed to load signer|java\.io\.FileNotFoundException: .*keystore/,
    de: "apkc", lit: "there is no keystore at",
    capa: "entorno", que: "la ruta pasada con --keystore no apunta a ningún archivo",
    hacer: "compruébala con ls: `apkc doctor` imprime la ruta que está usando y --keystore toma otra. Antes de este cambio la firma en Go la rechazaba con su propio mensaje, pero --signer=jvm dejaba llegar la pila de Java de apksigner; ahora apkc lo corta antes de elegir backend." },
  { id: "aar-not-read", re: /not a PKCS#12 file|not a JKS keystore|is neither a PKCS#12 nor a JKS/,
    de: "apkc", lit: "is neither a PKCS#12 nor a JKS keystore",
    capa: "entorno", que: "el almacén no es un formato que apkc pueda abrir",
    hacer: "conviértelo: keytool -importkeystore -srckeystore viejo -destkeystore nuevo -deststoretype PKCS12. Si no puedes, construye con --signer=jvm." },
  { id: "keystore-password", re: /did not open with the given storepass|password does not open this JKS|tampered with, or the password is wrong/,
    de: "apkc", lit: "did not open with the given storepass",
    capa: "entorno", que: "la contraseña del keystore no abre el almacén",
    hacer: "pasa --storepass con la correcta; en el de depuración es android." },
  { id: "keystore-alias", re: /holds \d+ key\(s\)|and none is /,
    de: "apkc", lit: "and none is",
    capa: "entorno", que: "el alias pedido no está en el keystore",
    hacer: "mira los nombres: keytool -list -keystore <ruta>. Con uno solo y sin nombre, apkc lo usa sin preguntar." },
  { id: "kotlinc", re: /kotlinc is not on PATH/,
    de: "apkc", lit: "kotlinc is not on PATH",
    capa: "entorno", que: "hay fuentes .kt pero no está el compilador de Kotlin",
    hacer: "instala kotlinc o quita los .kt; apkc no baja herramientas por su cuenta." },
  { id: "stdlib", re: /no kotlin-stdlib\*\.jar in jar/,
    de: "apkc", lit: "no kotlin-stdlib",
    capa: "entorno", que: "falta la librería estándar de Kotlin en jar/",
    hacer: "copia kotlin-stdlib-<versión>.jar a jar/: se compila sin ella y luego falta en el arranque." },
  { id: "duplicate-class", re: /is defined multiple times/,
    de: "apkc", lit: "is defined multiple times",
    capa: "proyecto", que: "la misma clase la aportan el proyecto y una dependencia",
    hacer: "quita el jar que la repite o cambia el paquete propio. Es un fallo duro a propósito: dos copias de una clase se resuelven en tiempo de ejecución a elegir una." },
  { id: "d8-drop", re: /was not found, it is required for|desugaring/,
    de: "d8", lit: "it is required for",
    capa: "proyecto", que: "d8 descarta una clase por un tipo que no ve",
    hacer: "normalmente falta el jar que aporta ese tipo; si es una dependencia entre cubos, comprueba que el jar está en jar/." },
  { id: "d8-bucket", re: /the d8 of dependency bucket \d+ failed/,
    de: "apkc", lit: "the d8 of dependency bucket",
    capa: "herramienta", que: "un cubo de dependencias no dejó de dexar",
    hacer: "el log lleva la salida de d8 debajo. Si es memoria, vuelve con APKC_JOBS=1; si es un jar concreto, quítalo y prueba." },
  { id: "bundletool", re: /no bundletool( found)?:/,
    de: "apkc", lit: "no bundletool:",
    capa: "entorno", que: "se pidió un .aab y bundletool no está por ningún sitio que apkc mira",
    hacer: "bájate el jar a ~/Android/bundletool o pon bundletool en el PATH." },
  { id: "jarsigner", re: /no jarsigner at/,
    de: "apkc", lit: "no jarsigner at",
    capa: "entorno", que: "sin jarsigner no se puede firmar un bundle",
    hacer: "el jarsigner viene con el JDK; si apkc resolvió otro, revisa JAVA_HOME." },
  { id: "install-signature", re: /INSTALL_FAILED_UPDATE_INCOMPATIBLE/,
    de: "pm", lit: "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    capa: "dispositivo", que: "la app instalada está firmada con otra clave",
    hacer: "desinstala la versión instalada, o vuelve a la clave con la que se instaló por primera vez." },
  { id: "install-other", re: /INSTALL_FAILED_[A-Z_]+/,
    de: "pm", lit: "INSTALL_FAILED_",
    capa: "dispositivo", que: "el gestor de paquetes rechazó la instalación",
    hacer: "el código dice el motivo; el log de apkc imprime la línea que devolvió pm." },
  { id: "pid", re: /couldn't get the pid|not running/,
    de: "apkc", lit: "couldn't get the pid",
    capa: "dispositivo", que: "la app murió antes de que existiera un proceso del que leer el log",
    hacer: "apkc vuelca el buffer de fallos del teléfono antes de decir nada: mira la excepción FATAL que sale arriba." },
  { id: "native-libs", re: /no android:extractNativeLibs in the manifest/,
    de: "apkc", lit: "no android:extractNativeLibs in the manifest",
    capa: "informativo", que: "aviso: los .so viajan comprimidos porque el manifest no dice nada",
    hacer: "no es un error. Si quieres que el sistema los mapee desde el apk, pon extractNativeLibs=\"false\" y apkc los guarda sin comprimir y alineados a página." },
  { id: "type-changed", re: /The project type changed/,
    de: "apkc", lit: "The project type changed",
    capa: "informativo", que: "cambió el tipo (apk/aab) respecto al último build",
    hacer: "esperado: una ronda completa." },
  { id: "constants-moved", re: /recompiling every source: a constant value moved/,
    de: "apkc", lit: "recompiling every source: a constant value moved",
    capa: "informativo", que: "un valor de R.* o de una constante obligó a recompilar todo",
    hacer: "esperado: javac copia los valores constantes dentro de los .class, así que no se puede invalidar solo a quien lo leía." },
  { id: "state-version", re: /state version \d+ is not \d+/,
    de: "apkc", lit: "state version",
    capa: "informativo", que: "el estado incremental lo escribió otra versión de apkc",
    hacer: "normal tras actualizar: una ronda produce todo otra vez." },
  { id: "not-a-class", re: /not a class file|cannot be read, writing every entry again/,
    de: "apkc", lit: "cannot be read, writing every entry again",
    capa: "herramienta", que: "algo que apkc esperaba leer no es lo que decía ser",
    hacer: "si aparece en el medio de un build correcto, es un fichero corrupto en build/: apkc clean y otra ronda." },
];

function analyze(text) {
  const hits = [];
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) hits.push({ ...rule, linea: m[0] });
  }
  // una línea que no es reconocida también es dato: sin ella la página solo sabría de lo
  // que ya conoce
  const desconocidas = text.split("\n")
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
    .filter((l) => l && /\[(build|sign|d8|doctor|create|clean|run|watch|watcher|incremental|timing|javac|kotlinc|apkc)\]/i.test(l))
    .filter((l) => !RULES.some((r) => r.re.test(l)))
    .filter((l) => !/^\[timing\]|^\[watch\] round|finished in|Detected a file changed|^\[(build|sign)\] (compiling|bundling|packaging|running|signing|dexing)/i.test(l));
  return { hits, desconocidas: [...new Set(desconocidas)].slice(0, 12) };
}

// ---------------------------------------------------------------- medida de friccion
const STORE_KEY = "apkc-studio/v1";

function loadLog() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { pasos: [], eventos: [] }; }
  catch (e) { return { pasos: [], eventos: [] }; }
}
// localStorage puede estar lleno o prohibido (modo privado): perder los contadores no puede
// impedir que el diagnóstico pinte lo que ya analizó en memoria
function saveLog(l) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(l)); }
  catch (e) { /* sin persistencia, la página sigue */ }
}
function registrar(tipo, detalle) {
  const l = loadLog();
  l.eventos.push({ t: new Date().toISOString(), tipo, detalle: detalle || null });
  saveLog(l);
  return l;
}

function informe() {
  const l = loadLog();
  const cuenta = {};
  for (const e of l.eventos) cuenta[e.tipo + (e.detalle ? ": " + e.detalle : "")] =
    (cuenta[e.tipo + (e.detalle ? ": " + e.detalle : "")] || 0) + 1;
  const porCapa = {};
  for (const [k, n] of Object.entries(cuenta)) if (k.startsWith("regla:")) {
    const regla = RULES.find((r) => r.id === k.split(": ").slice(1).join(": "));
    if (regla) porCapa[regla.capa] = (porCapa[regla.capa] || 0) + n;
  }
  let md = "# informe de uso de apkc\n\n";
  md += `- eventos: ${l.eventos.length}\n- generado: ${new Date().toISOString()}\n`;
  if (Object.keys(porCapa).length) {
    md += "\n## dónde se atascó, por capa\n\n";
    for (const [c, n] of Object.entries(porCapa).sort((a, b) => b[1] - a[1]))
      md += `- ${c}: ${n}\n`;
  }
  const friccion = Object.entries(cuenta).filter(([k]) => k.startsWith("friccion: "))
    .sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (friccion.length) {
    md += "\n## líneas sin explicar (lo que más fricción dio)\n\n";
    for (const [k, n] of friccion) md += `- ${k.slice("friccion: ".length)} ×${n}\n`;
  }
  if (Object.keys(cuenta).length) {
    md += "\n## conteo\n\n";
    for (const [k, n] of Object.entries(cuenta).sort((a, b) => b[1] - a[1]))
      md += `- \`${k}\` x${n}\n`;
  }
  md += "\n## pasos\n\n" + (l.pasos.map((p) => `- ${p}`).join("\n") || "(ninguno anotado)") + "\n";
  md += "\nLos logs pegados en la página se quedan en este navegador: aquí solo hay contadores y las líneas que la página reconoció.\n";
  return md;
}

export { buildProject, makeZip, analyze, crc32, RULES, loadLog, saveLog, registrar, informe };

// Puente para las pruebas de navegador que ya existen y para la consola de desarrollo.
// La página importa este módulo; no hay dependencia de estos globales en el código nuevo.
if (typeof window !== "undefined") {
  Object.assign(window, { buildProject, makeZip, analyze, crc32, RULES, loadLog, saveLog, registrar, informe });
}
