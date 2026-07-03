<?php

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Settings > LocalDock Companion — shows the per-site API key LocalDock
 * needs to authenticate against the REST endpoint, with a regenerate action.
 */
class LocalDock_Admin {

	const PAGE_SLUG = 'localdock-companion';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_page' ) );
		add_action( 'admin_post_localdock_regenerate_key', array( __CLASS__, 'handle_regenerate' ) );
	}

	public static function register_page() {
		add_options_page(
			__( 'LocalDock Companion', 'localdock-companion' ),
			__( 'LocalDock Companion', 'localdock-companion' ),
			'manage_options',
			self::PAGE_SLUG,
			array( __CLASS__, 'render_page' )
		);
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}

		$api_key     = get_option( 'localdock_api_key', '' );
		$regenerated = isset( $_GET['regenerated'] );
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'LocalDock Companion', 'localdock-companion' ); ?></h1>
			<p><?php esc_html_e( 'LocalDock (the cPanel WordPress extension) uses this key to authenticate its read-only change-tracking requests to this site. It is never used for write access.', 'localdock-companion' ); ?></p>

			<?php if ( $regenerated ) : ?>
				<div class="notice notice-success is-dismissible">
					<p><?php esc_html_e( 'API key regenerated. Enter the new key in LocalDock for this site — the old key no longer works.', 'localdock-companion' ); ?></p>
				</div>
			<?php endif; ?>

			<table class="form-table" role="presentation">
				<tr>
					<th scope="row">
						<label for="localdock-api-key"><?php esc_html_e( 'API Key', 'localdock-companion' ); ?></label>
					</th>
					<td>
						<input
							type="text"
							id="localdock-api-key"
							class="regular-text code"
							readonly="readonly"
							onclick="this.select();"
							value="<?php echo esc_attr( $api_key ); ?>"
						/>
						<p class="description"><?php esc_html_e( 'Click to select, then copy into LocalDock when provisioning this site.', 'localdock-companion' ); ?></p>
					</td>
				</tr>
			</table>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="localdock_regenerate_key" />
				<?php wp_nonce_field( 'localdock_regenerate_key' ); ?>
				<?php submit_button( __( 'Regenerate Key', 'localdock-companion' ), 'delete', 'submit', false ); ?>
				<p class="description"><?php esc_html_e( 'Immediately invalidates the current key. LocalDock will lose access to this site\'s change log until the new key is entered.', 'localdock-companion' ); ?></p>
			</form>
		</div>
		<?php
	}

	public static function handle_regenerate() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'localdock-companion' ) );
		}

		check_admin_referer( 'localdock_regenerate_key' );

		update_option( 'localdock_api_key', wp_generate_password( 40, false, false ) );

		wp_safe_redirect(
			add_query_arg(
				array(
					'page'         => self::PAGE_SLUG,
					'regenerated'  => '1',
				),
				admin_url( 'options-general.php' )
			)
		);
		exit;
	}
}
